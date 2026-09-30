/**
 * Sim worker logic (SPEC.md §10), independent of the worker global so it runs in Node tests.
 *
 * Owns the mesh, the TectonicSim, history keyframes and climate-input building. It does not paint:
 * every state to show (playback steps, paused state, history keyframes) goes to the paint worker as
 * a structured clone over the sim ⇄ paint channel (the sim keeps its memoized snapshot). Playback:
 * step `stepsPerFrame` → snapshot → post → wait for the paint worker's credit ('taken', sent when it
 * starts painting) → step again — so stepping and painting overlap instead of alternating.
 */
import { climateInputFromSnapshot } from '../climate/climate';
import { createSphereMesh } from '../core/sphereMesh';
import type { SphereMesh, TectonicParams, WorldDraft, WorldSnapshot } from '../core/types';
import { cloneDraft, draftFromSnapshot } from '../tectonics/draft';
import { generateRandomDraft } from '../tectonics/generate';
import { DEFAULT_TECTONIC_PARAMS, TectonicSim } from '../tectonics/sim';
import { KeyframeStore } from './keyframes';
import type { PortLike } from './paintHost';
import {
  climateInputTransfers, errorMessage, transferList,
  type DisplaySettings, type PaintQuality, type PaintToSim, type PerfStats, type PostFn, type ShowMessage,
  type SimEvent, type SimReplyMap, type SimRequest, type SimToPaint, type WorldLoaded,
} from './protocol';

export interface SimHostEnv {
  /** To the main thread. */
  post: PostFn<SimEvent>;
  /** Run `fn` in a later macrotask (lets queued messages — credits, pause — be handled in between). */
  schedule: (fn: () => void) => void;
  now: () => number;
  /** Optional overrides (tests use small budgets). */
  keyframes?: KeyframeStore;
}

/** Throttle for snapshot/status/history pushes during playback (SPEC: hover data ≤ every 250 ms). */
const PUSH_INTERVAL_MS = 250;
const MAX_STEPS_PER_FRAME = 100;

export class SimHost {
  private mesh: SphereMesh | null = null;
  /** Resolution of the mesh the paint worker holds (0 = none sent yet). */
  private paintMeshN = 0;
  private sim: TectonicSim | null = null;
  private seed = 1;
  private params: TectonicParams = { ...DEFAULT_TECTONIC_PARAMS };
  private readonly keyframes: KeyframeStore;
  private paintPort: PortLike | null = null;
  /** Messages for the paint worker posted before its channel was connected. */
  private paintQueue: SimToPaint[] = [];

  private epoch = 0;
  /** Latest display settings relayed from a main-thread request; sent with the next show. */
  private display: DisplaySettings | null = null;
  private displayDirty = false;
  /** Keyframe shown instead of the live state (null = live). */
  private viewing: number | null = null;

  private playing = false;
  private stepsPerFrame = 1;
  private showSeq = 0;
  /** Playback snapshot the paint worker has not taken yet (0 = none: free to step). */
  private awaiting = 0;
  private tickScheduled = false;

  private lastPush = -Infinity;
  private perf: PerfStats = { stepsPerSec: 0, framesPerSec: 0, lastStepMs: 0, lastPaintMs: 0, lastSnapshotMs: 0 };
  private win = { start: 0, steps: 0, frames: 0 };

  constructor(private readonly env: SimHostEnv) {
    this.keyframes = env.keyframes ?? new KeyframeStore();
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

  /** Connect the channel to the paint worker (also used in-process by InlinePipeline). */
  connectPaint(port: PortLike): void {
    if (this.paintPort && this.paintPort !== port) {
      this.paintPort.onmessage = null;
      this.paintPort.close?.();
    }
    this.paintPort = port;
    port.onmessage = (e: MessageEvent) => this.receivePaint(e.data as PaintToSim);
    const queued = this.paintQueue;
    this.paintQueue = [];
    for (const m of queued) port.postMessage?.(m);
  }

  /** A message from the paint worker. */
  receivePaint(m: PaintToSim): void {
    if (m?.type !== 'taken' || m.seq !== this.awaiting) return;
    this.awaiting = 0;
    if (this.playing) this.scheduleTick();
  }

  private toPaint(m: SimToPaint): void {
    if (this.paintPort?.postMessage) this.paintPort.postMessage(m);
    else this.paintQueue.push(m);
  }

  private setDisplay(d: DisplaySettings): void {
    this.display = d;
    this.displayDirty = true;
  }

  private dispatch(msg: SimRequest): void {
    switch (msg.type) {
      case 'connectPaint':
        this.connectPaint(msg.port);
        return this.reply(msg.reqId, 'connectPaint', null);
      case 'generate': {
        this.stopPlaying();
        this.ensureMesh(msg.meshN);
        const draft = generateRandomDraft(this.requireMesh(), msg.params);
        this.setDisplay(msg.display);
        this.params = { ...msg.tectonic };
        return this.reply(msg.reqId, 'generate', this.load(draft));
      }
      case 'loadDraft': {
        this.stopPlaying();
        if (!this.mesh || this.mesh.n !== msg.draft.n) this.ensureMesh(msg.draft.n);
        this.setDisplay(msg.display);
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
        this.setDisplay(msg.display);
        this.setStepsPerFrame(msg.stepsPerFrame);
        this.startPlaying();
        // Playback resumes the live state: tell the main thread now (a keyframe may have been on
        // screen), not after the ≤ 250 ms push throttle.
        this.pushState(true);
        return this.reply(msg.reqId, 'play', null);
      case 'pause':
        this.setDisplay(msg.display);
        this.stopPlaying();
        this.pushState(true);
        this.show('still', msg.reqId, 'full', false);
        return this.reply(msg.reqId, 'pause', null);
      case 'step': {
        this.setDisplay(msg.display);
        this.stopPlaying();
        this.viewing = null;
        const t0 = this.env.now();
        this.requireSim().step(Math.max(1, Math.min(MAX_STEPS_PER_FRAME, Math.round(msg.steps))));
        this.perf.lastStepMs = this.env.now() - t0;
        this.recordKeyframe();
        this.pushState(true);
        this.show('still', msg.reqId, 'full', false);
        return this.reply(msg.reqId, 'step', null);
      }
      case 'setSpeed':
        this.setStepsPerFrame(msg.stepsPerFrame);
        return this.reply(msg.reqId, 'setSpeed', null);
      case 'setTectonicParams':
        // The sim validates; invalid parameters must not be kept for later sims either.
        this.sim?.setParams({ ...msg.params, seed: this.sim.params.seed });
        this.params = { ...msg.params };
        return this.reply(msg.reqId, 'setTectonicParams', null);
      case 'showKeyframe': {
        this.setDisplay(msg.display);
        this.stopPlaying();
        if (msg.index !== null) this.keyframes.at(msg.index); // validates
        this.viewing = msg.index;
        this.pushState(true);
        this.show('still', 0, 'full', true);
        return this.reply(msg.reqId, 'showKeyframe', null);
      }
      case 'playFromKeyframe': {
        this.setDisplay(msg.display);
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
        // Climates (also those still in flight) for states after the branch point belong to the discarded future.
        this.toPaint({ type: 'branch', time: kf.time });
        this.viewing = null;
        this.resetPerf();
        this.pushState(true);
        this.show('still', 0, 'full', false);
        return this.reply(msg.reqId, 'playFromKeyframe', this.loadedInfo());
      }
      case 'climateInput': {
        const snap = this.displaySnapshot();
        const input = climateInputFromSnapshot(this.requireMesh(), snap, msg.params);
        // Registered before the reply: the climate computed from this input reaches the paint worker later.
        if (input.sourceId !== undefined) this.toPaint({ type: 'climateSource', snapshotId: input.sourceId, time: snap.time });
        return this.reply(msg.reqId, 'climateInput', input, climateInputTransfers(input));
      }
      case 'connectClimate':
      case 'connectSim':
      case 'frameAck':
      case 'paint':
      case 'exportImage':
        throw new Error(`sim worker: '${msg.type}' belongs to the paint worker`);
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
    this.viewing = null;
    this.resetPerf();
    this.toPaint({ type: 'world', epoch: this.epoch, meshN: mesh.n, mesh: this.paintMeshN === mesh.n ? null : mesh, seed: this.seed });
    this.paintMeshN = mesh.n;
    this.recordKeyframe();
    this.pushState(true);
    this.show('still', 0, 'full', true);
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
    this.awaiting = 0;
    this.resetPerf();
    this.scheduleTick();
  }

  private stopPlaying(): void {
    if (this.playing) this.toPaint({ type: 'stop', epoch: this.epoch });
    this.playing = false;
    this.awaiting = 0;
  }

  private scheduleTick(): void {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    this.env.schedule(this.tick);
  }

  private readonly tick = (): void => {
    this.tickScheduled = false;
    if (!this.playing || !this.sim) return;
    if (this.awaiting) return; // resumed by the paint worker's credit
    try {
      const t0 = this.env.now();
      this.sim.step(this.stepsPerFrame);
      const t1 = this.env.now();
      this.perf.lastStepMs = (t1 - t0) / this.stepsPerFrame;
      this.sim.snapshot();
      this.perf.lastSnapshotMs = this.env.now() - t1;
      // Hand the frame to the paint worker first; bookkeeping overlaps with its painting.
      this.show('play', 0, 'preview', false);
      this.recordKeyframe();
      this.win.steps += this.stepsPerFrame;
      this.win.frames++;
      this.updateRates();
      this.pushState(false);
    } catch (e) {
      this.playing = false;
      this.awaiting = 0;
      this.toPaint({ type: 'stop', epoch: this.epoch });
      this.env.post({ type: 'error', reqId: 0, message: `playback stopped: ${errorMessage(e)}` });
      this.pushState(true);
    }
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
  /* States for the paint worker                                         */
  /* ------------------------------------------------------------------ */

  /** Post the displayed state (live or keyframe) to the paint worker. */
  private show(kind: ShowMessage['kind'], reqId: number, quality: PaintQuality, previewFirst: boolean): void {
    const seq = ++this.showSeq;
    const msg: ShowMessage = {
      type: 'show', seq, epoch: this.epoch, reqId, kind, snapshot: this.displaySnapshot(), keyframe: this.viewing,
      display: this.displayDirty ? this.display : null, quality, parts: 'all', previewFirst,
    };
    this.displayDirty = false;
    if (kind === 'play') this.awaiting = seq;
    this.toPaint(msg);
  }

  private displaySnapshot(): WorldSnapshot {
    const sim = this.requireSim();
    if (this.viewing === null) return sim.snapshot();
    return this.keyframes.at(this.viewing).snapshot;
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
