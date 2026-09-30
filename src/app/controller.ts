/**
 * Application controller (SPEC.md §10): owns the three workers (sim, paint, climate), the main-thread copies of the world
 * (mesh, latest snapshot, latest climate) and the world lifecycle (generate, play/pause/step,
 * history, editor round trip, exports). Presentation lives in ViewSync / HoverController, store
 * reactions in effects.ts, the DOM shell in ui/layout.ts.
 */
import type { ClimateResult, GenerateParams, SphereMesh, TectonicParams, WorldDraft, WorldSnapshot } from '../core/types';
import { blankDraft } from '../tectonics/draft';
import {
  errorMessage, isStaleEpoch, LatestWins, transferList, type FrameMessage, type PaintParts, type WorldLoaded,
} from '../worker/protocol';
import { ClimateClient } from './climateClient';
import { ClimateCoordinator } from './climateCoordinator';
import type { Commands, UiContext } from './commands';
import { displaySettings, generateParams } from './display';
import { EditorBridge } from './editorBridge';
import { wireStoreEffects } from './effects';
import { layerUsesClimate } from '../worker/layerInfo';
import { downloadBlob, downloadUrl, exportName, rgbaToPngBlob } from './exportImage';
import { fmtNum } from './format';
import { FrameTask } from './frameTask';
import { HoverController } from './hoverController';
import { PlaybackPresenter } from './playbackPresenter';
import { installShortcuts, type Command } from './keyboard';
import { RateMeter } from './rateMeter';
import { PAINT_FULL } from './schema';
import { browserStorage, loadSettings } from './settings';
import { SimClient, type WorkerLike } from './simClient';
import { displayedTime, initialState, reduce, worldParamsKey, type Action, type AppState, type ViewKind } from './state';
import { createStore, shallowEqual, type Store } from './store';
import { createFirstRunHint } from './ui/firstRunHint';
import { buildLayout } from './ui/layout';
import type { RightPanel } from './ui/rightPanel';
import type { SimulateTab } from './ui/tabs/simulateTab';
import { Toasts } from './ui/toasts';
import type { Viewport } from './ui/viewport';
import { ViewSync } from './viewSync';

export interface AppWorkers {
  sim: () => WorkerLike;
  /** Paint worker for painter slot `slot` (0 = primary, ≥ 1 = playback helper). */
  paint: (slot?: number) => WorkerLike;
  climate: () => WorkerLike;
  /**
   * Extra paint workers for playback frames only (created with `paint`): painting is the slower
   * pipeline stage at 100k cells, so a helper roughly doubles the playback frame rate on machines
   * with spare cores. Default 0.
   */
  paintHelpers?: number;
}

export class App implements Commands {
  readonly store: Store<AppState, Action>;
  private readonly sim: SimClient;
  private readonly climateClient: ClimateClient;
  private readonly climate: ClimateCoordinator;
  private readonly toasts = new Toasts();
  private readonly viewport: Viewport;
  private readonly right: RightPanel;
  private readonly simulateTab: SimulateTab;
  private readonly editor: EditorBridge;
  private readonly viewSync: ViewSync;
  private readonly hover: HoverController;
  /** Still-frame paint requests: one in flight, latest wins. */
  private readonly paints: LatestWins<PaintParts>;

  /**
   * Bumped on pause (incl. editor entry while playing) / step / scrub / branch / load, each time with
   * a request that carries it to the worker; frames from older epochs are dropped.
   */
  private epoch = 1;
  private mesh: SphereMesh | null = null;
  private snapshot: WorldSnapshot | null = null;
  private climateResult: ClimateResult | null = null;
  /** A full-quality still frame is on its way (pause, step, scrub, load). */
  private awaitingStill = false;
  private generating = false;
  private scrubTarget: number | null | undefined = undefined;
  private readonly scrubTask = new FrameTask(() => this.sendScrub());
  /** Playback frames shown per second, and the paint worker's last paint time. */
  private readonly frameRate = new RateMeter();
  private lastPaintMs = 0;
  /** Playback frames from several painters: in order, one per display frame (PlaybackPresenter). */
  private readonly displayFrame = new FrameTask(() => this.playback.onDisplayFrame());
  private readonly playback = new PlaybackPresenter<FrameMessage>({
    present: (f) => this.present(f),
    isStale: (f) => isStaleEpoch(f.epoch, this.epoch),
    now: () => performance.now(),
    scheduleDisplayFrame: () => this.displayFrame.schedule(),
    setTimer: (fn, ms) => void globalThis.setTimeout(fn, ms),
  });

  constructor(root: HTMLElement, workers: AppWorkers) {
    const storage = browserStorage();
    this.store = createStore(initialState(loadSettings(storage)), reduce);
    const ctx: UiContext = { store: this.store, commands: this };

    const helpers = Array.from({ length: Math.max(0, Math.min(3, Math.floor(workers.paintHelpers ?? 0))) }, (_, i) => workers.paint(i + 1));
    this.sim = new SimClient(workers.sim(), workers.paint(), undefined, helpers);
    this.climateClient = new ClimateClient(workers.climate, (port, painter) => {
      this.sim.send({ type: 'connectClimate', epoch: this.epoch, port, painter }, [port]);
    }, undefined, Math.max(1, this.sim.painterCount));
    this.climate = new ClimateCoordinator({
      store: this.store, sim: this.sim, climate: this.climateClient, epoch: () => this.epoch,
      onResult: (c, ms) => this.applyClimate(c, ms),
      onError: (msg) => this.toasts.error('Climate computation failed', msg),
    });
    this.paints = new LatestWins<PaintParts>(
      (parts) => this.sim.send({ type: 'paint', epoch: this.epoch, display: displaySettings(this.store.getState()), quality: 'full', parts }),
      // A pending base repaint must survive a later overlay-only request.
      (a, b) => (a === 'all' || b === 'all' ? 'all' : 'overlay'),
    );

    const layout = buildLayout(ctx, {
      onPointer: (e) => this.hover.onPointer(e),
      onViewChanged: () => this.editor.viewChanged(),
      onError: (title, detail) => this.toasts.show('warn', title, detail),
    });
    this.viewport = layout.viewport;
    this.right = layout.right;
    this.simulateTab = layout.simulateTab;
    const data = { mesh: () => this.mesh, snapshot: () => this.snapshot, climate: () => this.climateResult };
    this.viewSync = new ViewSync(this.store, this.viewport, this.right, data);
    this.hover = new HoverController(this.store, this.right.inspector, { ...data, heightMap: () => this.viewport.heightMap });
    this.editor = new EditorBridge({
      host: layout.editorHost,
      getView: () => this.viewport.view,
      getMesh: () => this.mesh,
      requestDraft: (source, gen) => this.requestDraft(source, gen),
      onApply: (d) => void this.loadDraft(d),
      seaLevel: () => this.store.getState().settings.seaLevel,
      onError: (title, detail) => this.toasts.error(title, detail),
      worldStamp: () => {
        const rt = this.store.getState().runtime;
        return `${rt.worldSeed}|${rt.meshN}|${rt.steps}`;
      },
    });
    this.viewport.showCover({ kind: 'loading', title: 'Starting…', detail: 'Loading the simulation workers.' });
    this.viewport.el.appendChild(createFirstRunHint(ctx, storage, this.viewport.host, () => this.viewport.view?.getView?.().center ?? null));
    root.append(layout.root, this.toasts.el);

    this.wireWorker();
    wireStoreEffects(this.store, {
      requestPaint: (parts) => this.requestPaint(parts),
      viewSync: this.viewSync,
      hover: this.hover,
      climate: this.climate,
      setViewKind: (kind: ViewKind) => this.viewport.setKind(kind),
      enterEditor: () => void this.enterEditor(),
      exitEditor: () => this.exitEditor(),
      sendTectonicParams: (params: TectonicParams) => {
        this.sim.request({ type: 'setTectonicParams', epoch: this.epoch, params })
          .catch((e) => this.toasts.error('Invalid simulation parameters', errorMessage(e)));
      },
      sendSpeed: (stepsPerFrame) => this.sim.send({ type: 'setSpeed', epoch: this.epoch, stepsPerFrame }),
    }, storage);
    installShortcuts(window, () => ({ editorActive: this.store.getState().runtime.editorActive }), (c) => this.runShortcut(c));
    this.store.watch((s) => ({
      phase: s.runtime.climate.phase, pct: Math.round(s.runtime.climate.progress * 100), layer: s.settings.view.layer,
      playing: s.runtime.playing, seasons: s.runtime.seasonsPlaying, editing: s.runtime.editorActive,
    }), () => this.updateRendering(), { equal: shallowEqual });

    const want = this.store.getState().settings.view.view;
    const kind = this.viewport.setKind(want);
    if (kind !== want) this.store.dispatch({ type: 'patchView', patch: { view: kind } });
    this.viewSync.viewProps();
    this.generate();
  }

  /* ------------------------------------------------------------------ */
  /* Commands                                                            */
  /* ------------------------------------------------------------------ */

  generate(): void {
    if (this.generating) return;
    const s = this.store.getState();
    this.generating = true;
    this.beginNewWorld('Generating world…');
    const paramsKey = worldParamsKey(s.settings.world);
    this.sim.request({
      type: 'generate', epoch: this.epoch, meshN: s.settings.world.meshN, params: generateParams(s.settings.world),
      tectonic: s.settings.tectonic, display: displaySettings(s),
    })
      .then((loaded) => this.onWorldLoaded(loaded, paramsKey))
      .catch((e) => this.onLoadFailed('Could not generate the world', e))
      .finally(() => {
        this.generating = false;
        this.store.dispatch({ type: 'taskEnd', id: 'generate' });
      });
  }

  /** Dice: a new random seed, generated right away. */
  randomizeSeed(): void {
    // Keep the seed field in step with the world on screen: no new seed while one is loading.
    if (this.generating) return;
    this.store.dispatch({ type: 'patchWorld', patch: { seed: Math.floor(Math.random() * 1_000_000) } });
    this.generate();
  }

  togglePlay(): void {
    const rt = this.store.getState().runtime;
    // While a world loads the sim worker is busy with it; a queued play would start the new world
    // behind a UI that shows it paused.
    if (!rt.worldLoaded || rt.editorActive || this.generating) return;
    if (rt.playing) this.pause();
    else this.play();
  }

  step(): void {
    const s = this.store.getState();
    if (!s.runtime.worldLoaded || s.runtime.editorActive || this.generating) return;
    this.epoch++;
    // The worker stops playback before stepping.
    this.setPlaying(false);
    this.expectStill();
    this.sim.request({ type: 'step', epoch: this.epoch, steps: s.settings.speed, display: displaySettings(s) })
      .then(() => this.climateAfterChange('full'))
      .catch((e) => this.toasts.error('Step failed', errorMessage(e)));
  }

  showKeyframe(index: number | null): void {
    if (!this.store.getState().runtime.worldLoaded) return;
    // Coalesce scrubber drags to one request per frame (FrameTask: also runs in hidden tabs).
    this.scrubTarget = index;
    this.scrubTask.schedule();
  }

  private sendScrub(): void {
    const target = this.scrubTarget;
    this.scrubTarget = undefined;
    if (target === undefined || !this.store.getState().runtime.worldLoaded) return;
    this.epoch++;
    this.setPlaying(false);
    this.expectStill();
    this.sim.request({ type: 'showKeyframe', epoch: this.epoch, index: target, display: displaySettings(this.store.getState()) })
      .then(() => this.climateAfterChange(target === null ? 'full' : 'scrub'))
      .catch((e) => this.toasts.error('Could not show that point in history', errorMessage(e)));
  }

  playFromKeyframe(): void {
    const index = this.store.getState().runtime.viewingKeyframe;
    if (index === null) return;
    this.epoch++;
    this.setPlaying(false);
    this.expectStill();
    // A climate in flight may be for the discarded future; the branch point gets its own below.
    this.climate.branch();
    this.sim.request({ type: 'playFromKeyframe', epoch: this.epoch, index, display: displaySettings(this.store.getState()) })
      .then((loaded) => {
        this.store.dispatch({ type: 'worldLoaded', ...loaded });
        this.toasts.show('info', 'History branched', `Continuing from ${fmtNum(loaded.time, 1)} Myr; later keyframes were discarded.`);
        this.climateAfterChange('full');
      })
      .catch((e) => this.toasts.error('Could not branch from this keyframe', errorMessage(e)));
  }

  computeClimate(): void {
    if (this.store.getState().runtime.worldLoaded) this.climate.request('full', true);
  }

  toggleSeasons(): void {
    const rt = this.store.getState().runtime;
    this.store.dispatch({ type: 'setSeasonsPlaying', playing: !rt.seasonsPlaying });
    if (!rt.seasonsPlaying && !this.climateResult) {
      this.toasts.show('info', 'No climate yet', 'Seasons move the sun; snow, sea ice, clouds and particles follow once a climate is computed.');
    }
  }

  exportMap(): void {
    const s = this.store.getState();
    if (!s.runtime.worldLoaded) return;
    this.store.dispatch({ type: 'taskStart', id: 'export', label: 'Exporting map…' });
    this.sim.request({ type: 'exportImage', epoch: this.epoch, display: displaySettings(s), width: PAINT_FULL.w, height: PAINT_FULL.h })
      .then((img) => rgbaToPngBlob(img.rgba, img.overlay, img.width, img.height)
        .then((blob) => downloadBlob(blob, exportName(s.settings.view.layer, img.time))))
      .catch((e) => this.toasts.error('Export failed', errorMessage(e)))
      .finally(() => this.store.dispatch({ type: 'taskEnd', id: 'export' }));
  }

  exportScreenshot(): void {
    try {
      const s = this.store.getState();
      downloadUrl(this.viewport.screenshot(), exportName(`${s.settings.view.view}-${s.settings.view.layer}`, displayedTime(s.runtime)));
    } catch (e) {
      this.toasts.error('Screenshot failed', errorMessage(e));
    }
  }

  /** For debugging from the console (window.__worldgen). */
  debugState(): {
    epoch: number; mesh: number; snapshot: number; climate: number; painters: number; framesDropped: number; framesWithGap: number;
  } {
    return {
      epoch: this.epoch, mesh: this.mesh?.n ?? 0, snapshot: this.snapshot?.id ?? 0, climate: this.climateResult?.id ?? 0,
      painters: this.sim.painterCount, framesDropped: this.playback.sequencer.dropped, framesWithGap: this.playback.sequencer.gaps,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Playback & world lifecycle                                          */
  /* ------------------------------------------------------------------ */

  private play(): void {
    const s = this.store.getState();
    this.frameRate.reset();
    this.setPlaying(true);
    this.sim.request({ type: 'play', epoch: this.epoch, stepsPerFrame: s.settings.speed, display: displaySettings(s) })
      .catch((e) => {
        this.toasts.error('Could not start playback', errorMessage(e));
        this.setPlaying(false);
      });
  }

  private pause(requestClimate = true): void {
    this.epoch++;
    this.setPlaying(false);
    this.expectStill();
    this.sim.request({ type: 'pause', epoch: this.epoch, display: displaySettings(this.store.getState()) })
      .then(() => {
        if (requestClimate) this.climateAfterChange('full');
      })
      .catch((e) => this.toasts.error('Pause failed', errorMessage(e)));
  }

  /**
   * The UI's playing flag is the user's intent: a status posted by the worker before it handled a
   * play/pause request must not flip it back (the worker stopping on its own arrives as an error).
   */
  private setPlaying(playing: boolean): void {
    const rt = this.store.getState().runtime;
    if (rt.playing !== playing) this.store.dispatch({ type: 'status', playing, time: rt.time, steps: rt.steps, perf: rt.perf });
  }

  /** Auto climate after the displayed state changed (pause, step, scrub, branch). */
  private climateAfterChange(purpose: 'full' | 'scrub'): void {
    if (this.store.getState().settings.climate.live) this.climate.request(purpose, false);
  }

  private beginNewWorld(label: string): void {
    this.epoch++;
    // Loading stops playback in the worker (and a failed load must not leave the UI "playing").
    this.setPlaying(false);
    this.climate.resetWorld();
    this.climateResult = null;
    this.snapshot = null;
    this.paints.reset();
    this.awaitingStill = true;
    this.store.dispatch({ type: 'climateCleared' });
    this.store.dispatch({ type: 'taskStart', id: 'generate', label });
    this.viewport.showCover({ kind: 'loading', title: label, detail: 'Building plates, continents and relief.' });
    this.viewSync.weather();
  }

  private onWorldLoaded(loaded: WorldLoaded, paramsKey: string): void {
    const prevMesh = this.store.getState().runtime.meshN;
    this.store.dispatch({ type: 'worldLoaded', ...loaded, paramsKey });
    this.editor.worldChanged(prevMesh !== loaded.meshN);
    this.climateAfterChange('full');
    this.viewSync.legend();
    if (this.store.getState().settings.tab === 'plates' && !this.editor.isActive) void this.enterEditor();
  }

  private onLoadFailed(title: string, e: unknown): void {
    const msg = errorMessage(e);
    this.toasts.error(title, msg);
    const hasWorld = this.store.getState().runtime.worldLoaded && this.viewport.hasImage;
    this.viewport.showCover(hasWorld ? null : { kind: 'error', title, detail: msg });
    this.awaitingStill = false;
    this.updateRendering();
  }

  private async loadDraft(draft: WorldDraft): Promise<void> {
    if (this.generating) {
      this.toasts.show('warn', 'A world is still loading', 'Try “Simulate this world” again in a moment.');
      return;
    }
    this.generating = true;
    const s = this.store.getState();
    this.beginNewWorld('Loading your world…');
    try {
      const loaded = await this.sim.request(
        { type: 'loadDraft', epoch: this.epoch, draft, tectonic: s.settings.tectonic, display: displaySettings(s) },
        // The editor hands over a fresh clone (onApply(cloneDraft(d))): its buffers can move.
        transferList(draft.plate, draft.crust, draft.elev, draft.age, draft.orogeny),
      );
      this.onWorldLoaded(loaded, '');
      this.store.dispatch({ type: 'setTab', tab: 'simulate' });
      this.toasts.show('success', 'World loaded', 'Press Space to simulate your plates.');
    } catch (e) {
      this.onLoadFailed('Could not load the edited world', e);
    } finally {
      this.generating = false;
      this.store.dispatch({ type: 'taskEnd', id: 'generate' });
    }
  }

  private requestDraft(source: 'blank' | 'random' | 'current', gen?: Partial<GenerateParams>): Promise<WorldDraft> {
    const st = this.store.getState().settings;
    if (source === 'blank') {
      if (!this.mesh) return Promise.reject(new Error('no world loaded'));
      return Promise.resolve(blankDraft(this.mesh, st.world.seed));
    }
    if (source === 'random') return this.sim.request({ type: 'generateDraft', epoch: this.epoch, params: { ...generateParams(st.world), ...gen } });
    return this.sim.request({ type: 'getDraft', epoch: this.epoch });
  }

  private async enterEditor(): Promise<void> {
    const rt = this.store.getState().runtime;
    if (rt.editorActive) return;
    // Playback frames in flight become stale through pause()'s epoch bump (sent to the worker).
    // Without playback nothing is bumped: still frames for the current state keep arriving and are
    // cached by the suspended viewport for re-display on exit. (A bump the worker never hears of
    // would make it tag later frames — e.g. a repaint when a climate lands — with a stale epoch.)
    if (rt.playing) this.pause(false);
    if (rt.seasonsPlaying) this.store.dispatch({ type: 'setSeasonsPlaying', playing: false });
    this.hover.clear();
    this.viewport.suspend();
    this.store.dispatch({ type: 'setEditorActive', active: true });
    const ok = await this.editor.enter();
    if (!ok || this.store.getState().settings.tab !== 'plates') {
      if (ok) this.editor.exit();
      this.viewport.resume();
      this.store.dispatch({ type: 'setEditorActive', active: false });
    }
  }

  private exitEditor(): void {
    this.editor.exit();
    this.viewport.resume();
    this.store.dispatch({ type: 'setEditorActive', active: false });
  }

  /* ------------------------------------------------------------------ */
  /* Worker events                                                       */
  /* ------------------------------------------------------------------ */

  private wireWorker(): void {
    const sim = this.sim;
    sim.on('mesh', (e) => {
      this.mesh = e.mesh;
    });
    sim.on('frame', (f) => this.onFrame(f));
    sim.on('snapshot', (e) => {
      if (isStaleEpoch(e.epoch, this.epoch) && this.snapshot) return;
      this.snapshot = e.snapshot;
      this.store.dispatch({ type: 'snapshot', snapshotId: e.snapshot.id, stats: e.stats });
      this.simulateTab.setPlates(e.snapshot.plates);
      this.viewSync.legend();
      this.hover.refresh();
    });
    sim.on('history', (e) => this.store.dispatch({ type: 'history', keyframes: e.keyframes, intervalMyr: e.intervalMyr, viewing: e.viewing }));
    sim.on('status', (e) => {
      const playing = this.store.getState().runtime.playing;
      // Steps come from the sim worker; frames are counted where they are shown.
      const perf = { ...e.perf, framesPerSec: playing ? this.frameRate.rate(performance.now()) : 0, lastPaintMs: this.lastPaintMs };
      this.store.dispatch({ type: 'status', playing, time: e.time, steps: e.steps, perf });
      if (playing) {
        this.climate.playbackTick(e.time);
        // Sim and paint workers run side by side: the frame rate follows the slower stage.
        const simMs = perf.lastStepMs * this.store.getState().settings.speed + (perf.lastSnapshotMs ?? 0);
        // Several painters work side by side: each paints every n-th frame.
        const n = Math.max(1, this.sim.painterCount);
        const painters = n > 1 ? ` ×${n}` : '';
        this.viewport.setPerf(
          `${fmtNum(perf.framesPerSec, 0)} fps · sim ${fmtNum(simMs, 0)} ms ∥ paint ${fmtNum(perf.lastPaintMs, 0)} ms${painters}`,
          `${fmtNum(perf.stepsPerSec, 1)} steps/s · per frame: ${this.store.getState().settings.speed} step(s) at ${fmtNum(perf.lastStepMs, 0)} ms` +
            ` + snapshot ${fmtNum(perf.lastSnapshotMs ?? 0, 0)} ms (sim worker), paint ${fmtNum(perf.lastPaintMs, 0)} ms` +
            (n > 1 ? ` per frame on each of ${n} paint workers` : ' (paint worker)'),
        );
      } else {
        this.viewport.setPerf(null);
      }
    });
    sim.on('superseded', (e) => {
      this.paints.complete(e.reqId);
      this.updateRendering();
    });
    sim.on('error', (e) => {
      if (e.reqId) this.paints.complete(e.reqId);
      this.toasts.error('Simulation worker', e.message);
      // The sim stopped on its own: settle like a pause (new epoch, full still of the live state —
      // a helper may have shown a newer state than the primary painter holds).
      if (/playback stopped/.test(e.message) && this.store.getState().runtime.playing) this.pause(false);
      // The paint worker cannot stop the sim: a failing playback paint pauses it the normal way.
      if (/^paint failed/.test(e.message) && this.store.getState().runtime.playing) this.pause(false);
      if (/^paint failed/.test(e.message)) {
        // No frame is coming for this request: drop the "Rendering…" badge and the loading cover.
        this.awaitingStill = false;
        this.viewport.showCover(this.viewport.hasImage ? null : { kind: 'error', title: 'Could not render the world', detail: e.message });
      }
      this.updateRendering();
    });
    sim.onCrash((message) => {
      this.paints.reset();
      this.setPlaying(false);
      this.viewport.showCover({
        kind: 'error', title: 'The simulation worker stopped', detail: `${message}. The simulation state is lost; reload to start again.`,
        action: { label: 'Reload', onClick: () => location.reload() },
      });
    });
  }

  private onFrame(f: FrameMessage): void {
    // Acknowledge on receipt (to the painter that sent it) so painting never waits on the display.
    if (f.kind === 'play') this.sim.send({ type: 'frameAck', epoch: this.epoch, frameId: f.frameId, painter: f.painter });
    if (f.reqId) this.paints.complete(f.reqId);
    if (isStaleEpoch(f.epoch, this.epoch)) return;
    this.playback.receive(f);
  }

  private present(f: FrameMessage): void {
    if (f.kind === 'play') {
      const now = performance.now();
      this.frameRate.tick(now);
      this.playback.setFrameRate(this.frameRate.rate(now));
    }
    if (f.rgba) this.lastPaintMs = f.paintMs;
    this.viewport.applyFrame(f);
    if (f.keyframe === null) this.store.dispatch({ type: 'frameShown', time: f.time });
    this.viewport.showCover(null);
    if (f.kind === 'still' && f.quality === 'full') this.awaitingStill = false;
    this.updateRendering();
    this.hover.refresh();
  }

  private applyClimate(c: ClimateResult, ms: number): void {
    this.climateResult = c;
    this.store.dispatch({
      type: 'climateDone', id: c.id, sourceTime: c.sourceTime, sourceSnapshotId: c.sourceSnapshotId, fast: c.params.fast, ms, stats: c.stats,
    });
    this.viewSync.weather();
    this.viewSync.legend();
    this.hover.refresh();
  }

  /* ------------------------------------------------------------------ */
  /* Painting                                                            */
  /* ------------------------------------------------------------------ */

  private requestPaint(parts: PaintParts): void {
    if (!this.store.getState().runtime.worldLoaded) return;
    this.paints.submit(parts);
    this.updateRendering();
  }

  private expectStill(): void {
    this.awaitingStill = true;
    this.updateRendering();
  }

  /**
   * Busy badge over the view: "Rendering…" for still repaints, or the climate's progress while a
   * full climate is computed for a layer that shows it (the planet repaints when it lands). Hidden
   * during playback and seasons (constant repaints, live climate).
   */
  private updateRendering(): void {
    const s = this.store.getState();
    const rt = s.runtime;
    const idle = !rt.playing && !rt.seasonsPlaying && !rt.editorActive;
    const painting = idle && (this.awaitingStill || this.paints.busy);
    const c = rt.climate;
    const climate = idle && c.phase === 'computing' && c.purpose !== 'live' && layerUsesClimate(s.settings.view.layer);
    this.viewport.setRendering(painting || climate, painting ? 'Rendering…' : 'Computing climate…', painting ? '' : `${Math.round(c.progress * 100)}%`);
  }

  private runShortcut(c: Command): void {
    const st = this.store;
    switch (c.kind) {
      case 'togglePlay': return this.togglePlay();
      case 'step': return this.step();
      case 'view': return st.dispatch({ type: 'patchView', patch: { view: c.view } });
      case 'layer': return st.dispatch({ type: 'patchView', patch: { layer: c.layer } });
      case 'month': return st.dispatch({ type: 'stepMonth', delta: c.delta });
      case 'toggleSeasons': return this.toggleSeasons();
    }
  }
}
