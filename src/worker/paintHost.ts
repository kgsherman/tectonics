/**
 * Paint worker logic (SPEC.md §10), independent of the worker global so it runs in Node tests.
 *
 * Owns a copy of the mesh, the PaintCache and the climates received from the climate worker, and
 * paints whatever state the sim worker sends it (live playback snapshots, paused states, history
 * keyframes). Playback frames go straight to the main thread with at most FrameGate.max frames
 * unacknowledged; a playback snapshot is "taken" (credit back to the sim, which then steps again)
 * only when a frame slot is free, so sim, paint and main pipeline without running away. Still
 * paints (pause, layer/month changes, scrubbing, climate arrivals) are coalesced latest-wins.
 *
 * Painter slot (from connectSim): 0 = primary (everything above); a helper (slot ≥ 1) only paints
 * the playback snapshots the sim hands it, keeps just the newest climates and takes display
 * settings from the main thread's paint requests without replying to them.
 */
import type { ClimateResult, PaintSources, SphereMesh, WorldSnapshot } from '../core/types';
import { PaintCache } from '../render/paint';
import { ClimateShelf } from './climateShelf';
import { FramePainter } from './framePainter';
import { layerUsesClimate } from './layerInfo';
import {
  errorMessage, FrameGate, transferList,
  type ClimatePortMessage, type DisplaySettings, type FrameMessage, type PaintParts, type PaintQuality, type PaintToSim,
  type PostFn, type ShowMessage, type SimEvent, type SimReplyMap, type SimRequest, type SimToPaint,
} from './protocol';

/** Minimal MessagePort surface (a real port in the browser, an in-process fake in tests). */
export interface PortLike {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage?(msg: unknown, transfer?: Transferable[]): void;
  close?: () => void;
}

export interface PaintHostEnv {
  /** To the main thread. */
  post: PostFn<SimEvent>;
  /** Run `fn` in a later macrotask (lets queued messages — acks, stops — be handled in between). */
  schedule: (fn: () => void) => void;
  now: () => number;
  climates?: ClimateShelf;
  paintCache?: PaintCache;
  /**
   * Frees the painter's module-level scratch pools (tens of MB at 2048×1024, outside PaintCache's
   * budget); returns the bytes released. Called once the worker has been idle for `idleReleaseMs`
   * (not during playback): the next paint reallocates what it needs.
   */
  releaseScratch?: () => number | void;
  /** Idle time before `releaseScratch` runs (default IDLE_RELEASE_MS). */
  idleReleaseMs?: number;
  /** Delayed callback (default setTimeout); returns a cancel function. */
  later?: (fn: () => void, ms: number) => () => void;
}

/** Paint-worker idle time after which the painter's scratch pools are released. */
export const IDLE_RELEASE_MS = 15_000;

interface StillJob {
  reqId: number;
  quality: PaintQuality;
  parts: PaintParts;
  previewFirst: boolean;
}

/** State on screen. */
interface Shown {
  snapshot: WorldSnapshot;
  keyframe: number | null;
}

/** Max climates held back while their source registration is in flight (other channel). */
const MAX_WAITING_CLIMATES = 3;
/** A helper paints the live playback state only: the newest climate or two suffice. */
export const HELPER_CLIMATE_SHELF_BYTES = 48 * 1024 * 1024;

export class PaintHost {
  private mesh: SphereMesh | null = null;
  private seed = 1;
  private readonly painter: FramePainter;
  private climates: ClimateShelf;
  /** Painter slot (0 = primary; helpers paint playback frames only). */
  private slot = 0;
  /** Show sequence number of the state on screen (0 = unknown), and of its playback's first frame. */
  private shownSeq = 0;
  private playFrom: number | undefined = undefined;
  /** Snapshot id → sim time of every climate input built for the current world (and timeline). */
  private readonly climateSources = new Map<number, number>();
  /** Climates whose source registration has not arrived yet (it travels on the sim channel). */
  private waiting: ClimateResult[] = [];
  private simPort: PortLike | null = null;
  private climatePort: PortLike | null = null;

  private epoch = 0;
  private display: DisplaySettings | null = null;
  private shown: Shown | null = null;

  private playing = false;
  private pendingPlay: ShowMessage | null = null;
  private readonly gate = new FrameGate(2);
  private frameId = 0;
  private playScheduled = false;
  private still: StillJob | null = null;
  private pumpScheduled = false;
  private lastPaintedClimateId = 0;
  /** What the main thread holds (skip resending unchanged height maps / overlays within an epoch). */
  private sentHeight = { key: '', epoch: -1 };
  private sentOverlay = { key: '', epoch: -1 };
  /** Exports requested before the first state of a world arrived (the sim channel can lag the main one). */
  private pendingExports: Array<Extract<SimRequest, { type: 'exportImage' }>> = [];
  private cancelIdle: (() => void) | null = null;
  /** Bytes freed by the last idle release (diagnostics). */
  lastReleasedBytes = 0;

  constructor(private readonly env: PaintHostEnv) {
    this.painter = new FramePainter(env.paintCache ?? new PaintCache(), env.now);
    this.climates = env.climates ?? new ClimateShelf();
  }

  /* ------------------------------------------------------------------ */
  /* Main-thread requests                                                */
  /* ------------------------------------------------------------------ */

  handle(msg: SimRequest): void {
    if (msg.epoch > this.epoch) this.epoch = msg.epoch;
    try {
      this.dispatch(msg);
    } catch (e) {
      const message = errorMessage(e);
      if (msg.reqId) this.env.post({ type: 'reply', reqId: msg.reqId, ok: false, error: message });
      else this.env.post({ type: 'error', reqId: 0, message });
    }
  }

  private dispatch(msg: SimRequest): void {
    switch (msg.type) {
      case 'connectSim':
        this.connectSim(msg.port, msg.index ?? 0);
        return this.reply(msg.reqId, 'connectSim', null);
      case 'connectClimate':
        this.connectClimate(msg.port);
        return this.reply(msg.reqId, 'connectClimate', null);
      case 'frameAck':
        if (this.gate.ack(msg.frameId) && this.playing) this.schedulePlay();
        return;
      case 'paint':
        this.acceptDisplay(msg.display);
        // Helpers only need the settings (for their next playback frame); the primary answers.
        if (this.isHelper) return;
        if (this.playing) {
          // The next playback frame uses the new settings.
          if (msg.reqId) this.env.post({ type: 'superseded', reqId: msg.reqId });
          return;
        }
        this.queueStill({ reqId: msg.reqId, quality: msg.quality, parts: msg.parts, previewFirst: false });
        return;
      case 'exportImage':
        if (!this.shown) {
          this.pendingExports.push(msg);
          return;
        }
        return this.exportImage(msg);
      default:
        throw new Error(`paint worker: ${msg.type} belongs to the sim worker`);
    }
  }

  private exportImage(msg: Extract<SimRequest, { type: 'exportImage' }>): void {
    this.idleDisarm();
    const img = this.painter.exportImage(this.sources(), msg.display, msg.width, msg.height, this.seed);
    this.reply(msg.reqId, 'exportImage', img, transferList(img.rgba, img.overlay));
    this.idleArm();
  }

  /* ------------------------------------------------------------------ */
  /* Idle release of the painter's scratch memory                        */
  /* ------------------------------------------------------------------ */

  private idleDisarm(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
  }

  /** (Re)start the idle countdown after a paint; playback keeps painting, so it never arms. */
  private idleArm(): void {
    this.idleDisarm();
    const release = this.env.releaseScratch;
    if (!release || this.playing) return;
    const later = this.env.later ?? ((fn: () => void, ms: number) => {
      const id = globalThis.setTimeout(fn, ms);
      return () => globalThis.clearTimeout(id);
    });
    this.cancelIdle = later(() => {
      this.cancelIdle = null;
      if (this.playing || this.still || this.pendingPlay) return;
      try {
        this.lastReleasedBytes = Number(release()) || 0;
      } catch (e) {
        this.env.post({ type: 'error', reqId: 0, message: `paint worker: releasing scratch memory failed: ${errorMessage(e)}` });
      }
    }, this.env.idleReleaseMs ?? IDLE_RELEASE_MS);
  }

  private flushExports(): void {
    const list = this.pendingExports;
    this.pendingExports = [];
    for (const m of list) this.handle(m);
  }

  private reply<K extends keyof SimReplyMap>(reqId: number, _type: K, data: SimReplyMap[K], transfer?: Transferable[]): void {
    if (!reqId) return;
    this.env.post({ type: 'reply', reqId, ok: true, data }, transfer);
  }

  /** Newest display settings win (see DisplaySettings.seq). */
  private acceptDisplay(d: DisplaySettings | null): void {
    if (!d) return;
    const cur = this.display;
    if (!cur || d.seq === undefined || cur.seq === undefined || d.seq >= cur.seq) this.display = d;
  }

  /* ------------------------------------------------------------------ */
  /* Sim worker channel                                                  */
  /* ------------------------------------------------------------------ */

  private connectSim(port: PortLike, slot: number): void {
    if (this.simPort && this.simPort !== port) {
      this.simPort.onmessage = null;
      this.simPort.close?.();
    }
    this.simPort = port;
    port.onmessage = (e: MessageEvent) => this.receiveSim(e.data as SimToPaint);
    if (slot > 0 && this.slot === 0 && !this.env.climates) this.climates = new ClimateShelf(HELPER_CLIMATE_SHELF_BYTES);
    this.slot = slot;
  }

  /** Painter slot (0 = primary). */
  get painterSlot(): number {
    return this.slot;
  }

  private get isHelper(): boolean {
    return this.slot > 0;
  }

  /** A message from the sim worker. */
  receiveSim(m: SimToPaint): void {
    try {
      this.onSim(m);
    } catch (e) {
      this.env.post({ type: 'error', reqId: 0, message: `paint worker: ${errorMessage(e)}` });
    }
  }

  private onSim(m: SimToPaint): void {
    if ('epoch' in m && m.epoch > this.epoch) this.epoch = m.epoch;
    switch (m.type) {
      case 'world':
        if (m.mesh) {
          this.mesh = m.mesh;
          this.painter.cache.clear();
        }
        if (!this.mesh || this.mesh.n !== m.meshN) throw new Error(`no mesh with ${m.meshN} cells`);
        this.seed = m.seed;
        this.stopPlaying();
        this.shown = null;
        this.climates.clear();
        this.climateSources.clear();
        this.waiting = [];
        this.lastPaintedClimateId = 0;
        return;
      case 'show':
        this.acceptDisplay(m.display);
        if (m.kind === 'play') {
          this.startPlaying();
          // The sim waits for a credit before stepping again, so at most one snapshot is pending.
          this.pendingPlay = m;
          this.schedulePlay();
          return;
        }
        this.stopPlaying();
        this.shown = { snapshot: m.snapshot, keyframe: m.keyframe };
        this.shownSeq = m.seq;
        // A helper never shows stills: the sim sends it one to warm its caches for playback.
        if (this.isHelper) return this.env.schedule(this.warmUp);
        this.queueStill({ reqId: m.reqId, quality: m.quality, parts: m.parts, previewFirst: m.previewFirst });
        if (this.pendingExports.length) this.flushExports();
        return;
      case 'start':
        this.startPlaying();
        return;
      case 'stop':
        this.stopPlaying();
        this.idleArm();
        return;
      case 'climateSource': {
        this.climateSources.set(m.snapshotId, m.time);
        const ready = this.waiting.filter((c) => c.sourceSnapshotId === m.snapshotId);
        if (ready.length) {
          this.waiting = this.waiting.filter((c) => c.sourceSnapshotId !== m.snapshotId);
          for (const c of ready) this.receiveClimate(c);
        }
        return;
      }
      case 'branch':
        this.climates.dropAfter(m.time);
        for (const [id, t] of this.climateSources) if (t > m.time + 1e-6) this.climateSources.delete(id);
        this.waiting = this.waiting.filter((c) => c.sourceTime <= m.time + 1e-6);
        return;
      default: {
        const never: never = m;
        throw new Error(`unknown sim message ${JSON.stringify((never as { type?: unknown }).type)}`);
      }
    }
  }

  private credit(seq: number): void {
    const msg: PaintToSim = { type: 'taken', seq };
    this.simPort?.postMessage?.(msg);
  }

  /* ------------------------------------------------------------------ */
  /* Climates                                                            */
  /* ------------------------------------------------------------------ */

  private connectClimate(port: PortLike): void {
    if (this.climatePort && this.climatePort !== port) {
      this.climatePort.onmessage = null;
      this.climatePort.close?.();
    }
    this.climatePort = port;
    port.onmessage = (e: MessageEvent) => {
      const m = e.data as ClimatePortMessage;
      if (m && m.type === 'climate') {
        try {
          this.receiveClimate(m.climate);
        } catch (err) {
          this.env.post({ type: 'error', reqId: 0, message: `climate update: ${errorMessage(err)}` });
        }
      }
    };
  }

  /**
   * A climate arrived from the climate worker. Returns true when it was applied; climates for
   * states this world never registered wait for the registration (bounded) and are otherwise
   * dropped (a job for a previous world can finish just before the main thread cancels it).
   */
  receiveClimate(c: ClimateResult): boolean {
    if (!this.climateSources.has(c.sourceSnapshotId)) {
      this.waiting.push(c);
      if (this.waiting.length > MAX_WAITING_CLIMATES) this.waiting.shift();
      return false;
    }
    this.climates.add(c);
    // Helpers paint only playback frames, which pick it up (warm its samplers meanwhile when idle);
    // the primary reports and repaints.
    if (this.isHelper) {
      if (!this.playing) this.env.schedule(this.warmUp);
      return true;
    }
    this.env.post({ type: 'climateApplied', climateId: c.id, sourceTime: c.sourceTime });
    if (!this.shown || !this.display || this.playing) return true; // playback picks it up on the next frame
    if (!layerUsesClimate(this.display.layer)) return true;
    const shown = this.displayClimate();
    if (shown && shown.id !== this.lastPaintedClimateId) this.queueStill({ reqId: 0, quality: 'full', parts: 'all', previewFirst: false });
    return true;
  }

  private displayClimate(): ClimateResult | null {
    return this.shown ? this.climates.forTime(this.shown.snapshot.time) : null;
  }

  /* ------------------------------------------------------------------ */
  /* Playback frames                                                     */
  /* ------------------------------------------------------------------ */

  /** Playback began: pending still work is void (the next frames show newer states). */
  private startPlaying(): void {
    this.playing = true;
    this.idleDisarm();
    if (this.still?.reqId) this.env.post({ type: 'superseded', reqId: this.still.reqId });
    this.still = null;
  }

  private stopPlaying(): void {
    this.playing = false;
    this.pendingPlay = null;
    this.gate.reset();
  }

  private schedulePlay(): void {
    if (this.playScheduled) return;
    this.playScheduled = true;
    this.env.schedule(this.playTick);
  }

  private readonly playTick = (): void => {
    this.playScheduled = false;
    const m = this.pendingPlay;
    if (!this.playing || !m || !this.display || !this.mesh) return;
    if (!this.gate.canSend()) return; // resumed by frameAck
    this.pendingPlay = null;
    // Credit first: the sim computes the next step while this one is painted.
    this.credit(m.seq);
    this.shown = { snapshot: m.snapshot, keyframe: null };
    this.shownSeq = m.seq;
    this.playFrom = m.playFrom;
    try {
      const frame = this.paintFrame('play', 'preview', 'all', 0, m.epoch);
      this.gate.sent(frame.frameId);
    } catch (e) {
      this.env.post({ type: 'error', reqId: 0, message: `paint failed: ${errorMessage(e)}` });
    }
  };

  /** Helper: paint the shown state at playback quality without sending it (builds grid maps, detail, samplers). */
  private readonly warmUp = (): void => {
    if (this.playing || !this.shown || !this.display || !this.mesh) return;
    try {
      this.painter.frame(this.sources(), this.display, 'preview', 'all', this.seed, { height: true, overlay: false });
    } catch {
      // Warm-up only: a real playback frame reports its own failure.
    }
    this.idleArm();
  };

  /* ------------------------------------------------------------------ */
  /* Still frames                                                        */
  /* ------------------------------------------------------------------ */

  private queueStill(job: StillJob): void {
    const prev = this.still;
    if (prev) {
      if (prev.reqId && prev.reqId !== job.reqId) this.env.post({ type: 'superseded', reqId: prev.reqId });
      job = {
        reqId: job.reqId,
        quality: prev.quality === 'full' || job.quality === 'full' ? 'full' : 'preview',
        parts: prev.parts === 'all' || job.parts === 'all' ? 'all' : 'overlay',
        previewFirst: prev.previewFirst || job.previewFirst,
      };
    }
    this.still = job;
    if (!this.pumpScheduled) {
      this.pumpScheduled = true;
      this.env.schedule(this.pump);
    }
  }

  private readonly pump = (): void => {
    this.pumpScheduled = false;
    const job = this.still;
    this.still = null;
    if (!job) return;
    if (!this.shown || !this.display || !this.mesh || this.playing) {
      if (job.reqId) this.env.post({ type: 'superseded', reqId: job.reqId });
      return;
    }
    try {
      if (job.previewFirst && job.parts === 'all') {
        this.paintFrame('still', 'preview', 'all', 0, this.epoch);
        // Refine unless a newer request already replaced this one.
        if (!this.still) this.queueStill({ ...job, previewFirst: false });
        return;
      }
      this.paintFrame('still', job.quality, job.parts, job.reqId, this.epoch);
    } catch (e) {
      this.env.post({ type: 'error', reqId: job.reqId, message: `paint failed: ${errorMessage(e)}` });
    }
  };

  /* ------------------------------------------------------------------ */
  /* Painting                                                            */
  /* ------------------------------------------------------------------ */

  private sources(): PaintSources {
    if (!this.mesh || !this.shown) throw new Error('No world loaded yet');
    return { mesh: this.mesh, snapshot: this.shown.snapshot, climate: this.displayClimate() };
  }

  private paintFrame(kind: FrameMessage['kind'], quality: PaintQuality, parts: PaintParts, reqId: number, epoch: number): FrameMessage {
    this.idleDisarm();
    const d = this.display!;
    const src = this.sources();
    const snap = src.snapshot!;
    const { width, height } = FramePainter.size(d, quality);
    // The height map depends on the surface only; the overlay also on its flags. Skip what the main
    // thread already holds for this epoch (month / layer changes, climate repaints).
    const hKey = `${snap.id}|${width}x${height}|${quality}|${d.seaLevel}|${d.detail}|${this.seed}`;
    const oKey = `${hKey}|${d.overlays.boundaries ? 1 : 0}${d.overlays.coastlines ? 1 : 0}`;
    const wantHeight = parts === 'all' && !(this.sentHeight.key === hKey && this.sentHeight.epoch === epoch);
    const wantOverlay = !(this.sentOverlay.key === oKey && this.sentOverlay.epoch === epoch);
    const p = this.painter.frame(src, d, quality, parts, this.seed, { height: wantHeight, overlay: wantOverlay });
    if (parts === 'all') this.lastPaintedClimateId = src.climate?.id ?? 0;
    if (p.heightMap) this.sentHeight = { key: hKey, epoch };
    if (p.overlayRepainted) this.sentOverlay = { key: oKey, epoch };
    const frame: FrameMessage = {
      type: 'frame', frameId: ++this.frameId, reqId, epoch, kind, quality, layer: d.layer, month: d.month,
      width: p.width, height: p.height, rgba: p.rgba, heightMap: p.heightMap, overlay: p.overlay, overlayRepainted: p.overlayRepainted,
      snapshotId: snap.id, time: snap.time, climateId: src.climate?.id ?? 0, keyframe: this.shown!.keyframe, paintMs: p.ms,
      painter: this.slot, showSeq: this.shownSeq, playFrom: kind === 'play' ? this.playFrom : undefined,
    };
    this.env.post(frame, transferList(p.rgba, p.heightMap, p.overlay));
    if (kind === 'still') this.idleArm();
    return frame;
  }
}
