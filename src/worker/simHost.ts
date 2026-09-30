/**
 * Sim/paint worker logic (SPEC.md §10), independent of the worker global so it runs in Node tests.
 *
 * Owns the mesh, the TectonicSim, the PaintCache, history keyframes and the climates received from
 * the climate worker. Playback: each frame = `stepsPerFrame` steps → preview paint (layer + height
 * map + overlay) → transfer, with at most FrameGate.max unacknowledged frames in flight. Still
 * paints (pause, layer/month changes, scrubbing) are coalesced latest-wins.
 */
import { climateInputFromSnapshot } from '../climate/climate';
import { createSphereMesh } from '../core/sphereMesh';
import type {
  ClimateResult, PaintSources, SphereMesh, TectonicParams, WorldDraft, WorldSnapshot,
} from '../core/types';
import { cloneDraft, draftFromSnapshot } from '../tectonics/draft';
import { generateRandomDraft } from '../tectonics/generate';
import { DEFAULT_TECTONIC_PARAMS, TectonicSim } from '../tectonics/sim';
import { PaintCache } from '../render/paint';
import { ClimateShelf } from './climateShelf';
import { FramePainter } from './framePainter';
import { KeyframeStore } from './keyframes';
import { layerUsesClimate } from './layerInfo';
import {
  climateInputTransfers, errorMessage, FrameGate, transferList,
  type ClimatePortMessage, type DisplaySettings, type FrameMessage, type PaintParts, type PaintQuality, type PerfStats,
  type PostFn, type SimEvent, type SimReplyMap, type SimRequest, type WorldLoaded,
} from './protocol';

export interface SimHostEnv {
  post: PostFn<SimEvent>;
  /** Run `fn` in a later macrotask (lets queued messages — acks, pause — be handled in between). */
  schedule: (fn: () => void) => void;
  now: () => number;
  /** Optional overrides (tests use small budgets). */
  keyframes?: KeyframeStore;
  climates?: ClimateShelf;
  paintCache?: PaintCache;
}

/** Throttle for snapshot/status/history pushes during playback (SPEC: hover data ≤ every 250 ms). */
const PUSH_INTERVAL_MS = 250;
const MAX_STEPS_PER_FRAME = 100;

interface StillJob {
  reqId: number;
  quality: PaintQuality;
  parts: PaintParts;
  /** Paint a quick preview before the full-quality frame (first look after load). */
  previewFirst: boolean;
}

/** Minimal MessagePort surface used for the climate channel. */
interface PortLike {
  onmessage: ((e: MessageEvent) => void) | null;
  close?: () => void;
}

export class SimHost {
  private mesh: SphereMesh | null = null;
  private sim: TectonicSim | null = null;
  private seed = 1;
  private params: TectonicParams = { ...DEFAULT_TECTONIC_PARAMS };
  private readonly painter: FramePainter;
  private readonly keyframes: KeyframeStore;
  private readonly climates: ClimateShelf;
  private port: PortLike | null = null;

  private epoch = 0;
  private display: DisplaySettings | null = null;
  /** Keyframe shown instead of the live state (null = live). */
  private viewing: number | null = null;

  private playing = false;
  private stepsPerFrame = 1;
  private readonly gate = new FrameGate(2);
  private frameId = 0;
  private tickScheduled = false;
  private still: StillJob | null = null;
  private pumpScheduled = false;
  private lastPaintedClimateId = 0;
  /**
   * Snapshot id → sim time of every climate input built in the current world (and timeline):
   * climates for anything else are stale.
   */
  private readonly climateSources = new Map<number, number>();

  private lastPush = -Infinity;
  private perf: PerfStats = { stepsPerSec: 0, framesPerSec: 0, lastStepMs: 0, lastPaintMs: 0 };
  private win = { start: 0, steps: 0, frames: 0 };

  constructor(private readonly env: SimHostEnv) {
    this.painter = new FramePainter(env.paintCache ?? new PaintCache(), env.now);
    this.keyframes = env.keyframes ?? new KeyframeStore();
    this.climates = env.climates ?? new ClimateShelf();
  }

  /* ------------------------------------------------------------------ */
  /* Message dispatch                                                    */
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

  /** A climate arrived from the climate worker (via the MessageChannel). */
  receiveClimate(c: ClimateResult): boolean {
    // A job for a previous world can finish just before the main thread cancels it: ignore it.
    if (!this.climateSources.has(c.sourceSnapshotId)) return false;
    this.climates.add(c);
    this.env.post({ type: 'climateApplied', climateId: c.id, sourceTime: c.sourceTime });
    if (!this.sim || !this.display || this.playing) return true; // playback picks it up on the next frame
    if (!layerUsesClimate(this.display.layer)) return true;
    const shown = this.displayClimate();
    if (shown && shown.id !== this.lastPaintedClimateId) this.queueStill({ reqId: 0, quality: 'full', parts: 'all', previewFirst: false });
    return true;
  }

  private dispatch(msg: SimRequest): void {
    switch (msg.type) {
      case 'connectClimate':
        this.connectPort(msg.port);
        return this.reply(msg.reqId, 'connectClimate', null);
      case 'generate': {
        this.stopPlaying();
        this.ensureMesh(msg.meshN);
        const draft = generateRandomDraft(this.requireMesh(), msg.params);
        this.display = msg.display;
        this.params = { ...msg.tectonic };
        return this.reply(msg.reqId, 'generate', this.load(draft));
      }
      case 'loadDraft': {
        this.stopPlaying();
        if (!this.mesh || this.mesh.n !== msg.draft.n) this.ensureMesh(msg.draft.n);
        this.display = msg.display;
        this.params = { ...msg.tectonic };
        return this.reply(msg.reqId, 'loadDraft', this.load(msg.draft));
      }
      case 'generateDraft': {
        const d = generateRandomDraft(this.requireMesh(), msg.params);
        return this.reply(msg.reqId, 'generateDraft', d, draftTransfers(d));
      }
      case 'getDraft': {
        const d = this.requireSim().toDraft();
        return this.reply(msg.reqId, 'getDraft', d, draftTransfers(d));
      }
      case 'play':
        this.display = msg.display;
        this.setStepsPerFrame(msg.stepsPerFrame);
        this.startPlaying();
        // Playback resumes the live state: tell the main thread now (a keyframe may have been on
        // screen), not after the ≤ 250 ms push throttle.
        this.pushState(true);
        return this.reply(msg.reqId, 'play', null);
      case 'pause':
        this.display = msg.display;
        this.stopPlaying();
        this.pushState(true);
        this.queueStill({ reqId: msg.reqId, quality: 'full', parts: 'all', previewFirst: false });
        return this.reply(msg.reqId, 'pause', null);
      case 'step': {
        this.display = msg.display;
        this.stopPlaying();
        this.viewing = null;
        const t0 = this.env.now();
        this.requireSim().step(Math.max(1, Math.min(MAX_STEPS_PER_FRAME, Math.round(msg.steps))));
        this.perf.lastStepMs = this.env.now() - t0;
        this.recordKeyframe();
        this.pushState(true);
        this.queueStill({ reqId: msg.reqId, quality: 'full', parts: 'all', previewFirst: false });
        return this.reply(msg.reqId, 'step', null);
      }
      case 'setSpeed':
        this.setStepsPerFrame(msg.stepsPerFrame);
        return this.reply(msg.reqId, 'setSpeed', null);
      case 'frameAck':
        if (this.gate.ack(msg.frameId) && this.playing) this.scheduleTick();
        return;
      case 'setTectonicParams':
        // The sim validates; invalid parameters must not be kept for later sims either.
        this.sim?.setParams({ ...msg.params, seed: this.sim.params.seed });
        this.params = { ...msg.params };
        return this.reply(msg.reqId, 'setTectonicParams', null);
      case 'paint':
        this.display = msg.display;
        if (this.playing) {
          // The next playback frame uses the new settings.
          if (msg.reqId) this.env.post({ type: 'superseded', reqId: msg.reqId });
          return;
        }
        this.queueStill({ reqId: msg.reqId, quality: msg.quality, parts: msg.parts, previewFirst: false });
        return;
      case 'showKeyframe': {
        this.display = msg.display;
        this.stopPlaying();
        if (msg.index !== null) this.keyframes.at(msg.index); // validates
        this.viewing = msg.index;
        this.pushState(true);
        this.queueStill({ reqId: 0, quality: 'full', parts: 'all', previewFirst: true });
        return this.reply(msg.reqId, 'showKeyframe', null);
      }
      case 'playFromKeyframe': {
        this.display = msg.display;
        this.stopPlaying();
        const kf = this.keyframes.at(msg.index);
        // Resume from the exact sim state (toDraft) when the keyframe has it; the display snapshot
        // carries trench offsets and interpolated elevations that must not become crust.
        const draft = kf.draft ? cloneDraft(kf.draft) : draftFromSnapshot(kf.snapshot, this.seed, kf.steps);
        // Plate ids are never reused within a session: plates born after the keyframe (in the
        // discarded future) or dead before it keep their ids reserved.
        if (this.sim) draft.nextPlateId = Math.max(draft.nextPlateId, this.sim.toDraft().nextPlateId);
        this.sim = new TectonicSim(this.requireMesh(), draft, { ...this.params, seed: this.seed });
        this.keyframes.truncateAfter(msg.index);
        this.climates.dropAfter(kf.time);
        // A climate still in flight for a state after the branch point belongs to the discarded future.
        for (const [id, t] of this.climateSources) if (t > kf.time + 1e-6) this.climateSources.delete(id);
        this.viewing = null;
        this.resetPerf();
        this.pushState(true);
        this.queueStill({ reqId: 0, quality: 'full', parts: 'all', previewFirst: false });
        return this.reply(msg.reqId, 'playFromKeyframe', this.loadedInfo());
      }
      case 'climateInput': {
        const snap = this.displaySnapshot();
        const input = climateInputFromSnapshot(this.requireMesh(), snap, msg.params);
        if (input.sourceId !== undefined) this.climateSources.set(input.sourceId, snap.time);
        return this.reply(msg.reqId, 'climateInput', input, climateInputTransfers(input));
      }
      case 'exportImage': {
        const img = this.painter.exportImage(this.sources(), msg.display, msg.width, msg.height, this.seed);
        return this.reply(msg.reqId, 'exportImage', img, transferList(img.rgba, img.overlay));
      }
      default: {
        const never: never = msg;
        throw new Error(`sim worker: unknown request ${JSON.stringify((never as { type?: unknown }).type)}`);
      }
    }
  }

  private reply<K extends keyof SimReplyMap>(reqId: number, _type: K, data: SimReplyMap[K], transfer?: Transferable[]): void {
    if (!reqId) return;
    this.env.post({ type: 'reply', reqId, ok: true, data }, transfer);
  }

  /* ------------------------------------------------------------------ */
  /* World lifecycle                                                     */
  /* ------------------------------------------------------------------ */

  private ensureMesh(n: number): void {
    if (!(Number.isInteger(n) && n >= 100)) throw new Error(`sim worker: invalid mesh size ${n}`);
    if (this.mesh && this.mesh.n === n) return;
    this.mesh = createSphereMesh(n);
    this.painter.cache.clear();
    // Structured clone: the worker keeps its own mesh.
    this.env.post({ type: 'mesh', meshN: this.mesh.n, mesh: this.mesh });
  }

  private load(draft: WorldDraft): WorldLoaded {
    const mesh = this.requireMesh();
    if (draft.n !== mesh.n) throw new Error(`sim worker: draft has ${draft.n} cells, mesh has ${mesh.n}`);
    // Construct first: a rejected draft must leave the current world (and its detail seed) intact.
    const sim = new TectonicSim(mesh, draft, { ...this.params, seed: draft.seed });
    this.seed = draft.seed;
    this.sim = sim;
    this.keyframes.clear();
    this.climates.clear();
    this.climateSources.clear();
    this.lastPaintedClimateId = 0;
    this.viewing = null;
    this.resetPerf();
    this.recordKeyframe();
    this.pushState(true);
    this.queueStill({ reqId: 0, quality: 'full', parts: 'all', previewFirst: true });
    return this.loadedInfo();
  }

  private loadedInfo(): WorldLoaded {
    const sim = this.requireSim();
    return { meshN: this.requireMesh().n, seed: this.seed, time: sim.time, stats: sim.stats() };
  }

  private recordKeyframe(): void {
    const sim = this.sim;
    // stats() is a full pass over the cells: only pay for it when a keyframe is due.
    if (!sim || !this.keyframes.isDue(sim.time)) return;
    this.keyframes.add(sim.time, sim.stats().steps, sim.snapshot(), sim.toDraft());
  }

  private connectPort(port: PortLike): void {
    if (this.port && this.port !== port) {
      this.port.onmessage = null;
      this.port.close?.();
    }
    this.port = port;
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

  /* ------------------------------------------------------------------ */
  /* Playback                                                            */
  /* ------------------------------------------------------------------ */

  private setStepsPerFrame(n: number): void {
    this.stepsPerFrame = Math.max(1, Math.min(MAX_STEPS_PER_FRAME, Math.round(Number.isFinite(n) ? n : 1)));
  }

  private startPlaying(): void {
    this.requireSim();
    this.viewing = null;
    this.playing = true;
    this.gate.reset();
    this.resetPerf();
    this.still = null;
    this.scheduleTick();
  }

  private stopPlaying(): void {
    this.playing = false;
    this.gate.reset();
  }

  private scheduleTick(): void {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    this.env.schedule(this.tick);
  }

  private readonly tick = (): void => {
    this.tickScheduled = false;
    if (!this.playing || !this.sim || !this.display) return;
    if (!this.gate.canSend()) return; // resumed by frameAck
    try {
      const t0 = this.env.now();
      this.sim.step(this.stepsPerFrame);
      const t1 = this.env.now();
      this.perf.lastStepMs = (t1 - t0) / this.stepsPerFrame;
      this.recordKeyframe();
      const frame = this.paintFrame('play', 'preview', 'all', 0);
      this.gate.sent(frame.frameId);
      this.win.steps += this.stepsPerFrame;
      this.win.frames++;
      this.updateRates();
      this.pushState(false);
    } catch (e) {
      this.playing = false;
      this.env.post({ type: 'error', reqId: 0, message: `playback stopped: ${errorMessage(e)}` });
      this.pushState(true);
      return;
    }
    this.scheduleTick();
  };

  private resetPerf(): void {
    this.win = { start: this.env.now(), steps: 0, frames: 0 };
    this.perf.stepsPerSec = 0;
    this.perf.framesPerSec = 0;
  }

  private updateRates(): void {
    const t = this.env.now();
    const dt = t - this.win.start;
    if (dt <= 0) return;
    this.perf.stepsPerSec = (1000 * this.win.steps) / dt;
    this.perf.framesPerSec = (1000 * this.win.frames) / dt;
    if (dt >= 1500) this.win = { start: t, steps: 0, frames: 0 };
  }

  /** Snapshot (for hover), status and history → main. Throttled during playback unless `force`. */
  private pushState(force: boolean): void {
    const t = this.env.now();
    if (!force && t - this.lastPush < PUSH_INTERVAL_MS) return;
    this.lastPush = t;
    const sim = this.sim;
    if (!sim) return;
    const snapshot = this.displaySnapshot();
    const stats = sim.stats();
    this.env.post({ type: 'snapshot', epoch: this.epoch, snapshot, stats, keyframe: this.viewing });
    this.env.post({
      type: 'history', keyframes: this.keyframes.list(), intervalMyr: this.keyframes.interval, bytes: this.keyframes.bytes, viewing: this.viewing,
    });
    this.env.post({ type: 'status', playing: this.playing, time: sim.time, steps: stats.steps, perf: { ...this.perf } });
  }

  /* ------------------------------------------------------------------ */
  /* Painting                                                            */
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
    if (!this.sim || !this.display || this.playing) {
      if (job.reqId) this.env.post({ type: 'superseded', reqId: job.reqId });
      return;
    }
    try {
      if (job.previewFirst && job.parts === 'all') {
        this.paintFrame('still', 'preview', 'all', 0);
        // Refine unless a newer request already replaced this one.
        if (!this.still) this.queueStill({ ...job, previewFirst: false });
        return;
      }
      this.paintFrame('still', job.quality, job.parts, job.reqId);
    } catch (e) {
      const message = `paint failed: ${errorMessage(e)}`;
      this.env.post({ type: 'error', reqId: job.reqId, message });
    }
  };

  private displaySnapshot(): WorldSnapshot {
    const sim = this.requireSim();
    if (this.viewing === null) return sim.snapshot();
    return this.keyframes.at(this.viewing).snapshot;
  }

  private displayClimate(): ClimateResult | null {
    if (!this.sim) return null;
    const t = this.viewing === null ? this.sim.time : this.keyframes.at(this.viewing).time;
    return this.climates.forTime(t);
  }

  private sources(): PaintSources {
    return { mesh: this.requireMesh(), snapshot: this.displaySnapshot(), climate: this.displayClimate() };
  }

  private paintFrame(kind: FrameMessage['kind'], quality: PaintQuality, parts: PaintParts, reqId: number): FrameMessage {
    const d = this.display!;
    const src = this.sources();
    const p = this.painter.frame(src, d, quality, parts, this.seed);
    if (parts === 'all') this.lastPaintedClimateId = src.climate?.id ?? 0;
    this.perf.lastPaintMs = p.ms;
    const snap = src.snapshot!;
    const frame: FrameMessage = {
      type: 'frame', frameId: ++this.frameId, reqId, epoch: this.epoch, kind, quality, layer: d.layer, month: d.month,
      width: p.width, height: p.height, rgba: p.rgba, heightMap: p.heightMap, overlay: p.overlay, overlayRepainted: true,
      snapshotId: snap.id, time: snap.time, climateId: src.climate?.id ?? 0, keyframe: this.viewing, paintMs: p.ms,
    };
    this.env.post(frame, transferList(p.rgba, p.heightMap, p.overlay));
    return frame;
  }

  /* ------------------------------------------------------------------ */

  private requireMesh(): SphereMesh {
    if (!this.mesh) throw new Error('No world loaded yet (mesh not built)');
    return this.mesh;
  }

  private requireSim(): TectonicSim {
    if (!this.sim) throw new Error('No world loaded yet');
    return this.sim;
  }
}

/** A draft built fresh for a reply: its buffers can move. */
function draftTransfers(d: WorldDraft): Transferable[] {
  return transferList(d.plate, d.crust, d.elev, d.age, d.orogeny);
}
