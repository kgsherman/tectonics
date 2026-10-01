/**
 * Store → side effects: which state changes repaint, re-light, re-run the climate, reach the sim
 * worker, toggle the editor or persist settings. Kept declarative so the controller stays small.
 */
import type { TectonicParams } from '../core/types';
import type { PaintParts } from '../worker/protocol';
import { layerIsMonthly, layerNeedsClimate } from '../worker/layerInfo';
import type { ClimateCoordinator } from './climateCoordinator';
import { flowGlyphs } from './display';
import type { HoverController } from './hoverController';
import { saveSettings, type KeyValueStorage } from './settings';
import type { Action, AppState, ViewKind } from './state';
import { shallowEqual, type Store } from './store';
import type { ViewSync } from './viewSync';

export interface EffectHost {
  requestPaint(parts: PaintParts): void;
  viewSync: ViewSync;
  hover: HoverController;
  climate: ClimateCoordinator;
  /** Switch globe ⇄ map; returns the kind actually created (globe falls back to map without WebGL). */
  setViewKind(kind: ViewKind): ViewKind;
  enterEditor(): void;
  exitEditor(): void;
  sendTectonicParams(params: TectonicParams): void;
  sendSpeed(stepsPerFrame: number, smooth: boolean): void;
}

const SAVE_DEBOUNCE_MS = 400;
const CLIMATE_PARAM_DEBOUNCE_MS = 450;
const TECTONIC_DEBOUNCE_MS = 150;

export function wireStoreEffects(store: Store<AppState, Action>, host: EffectHost, storage: KeyValueStorage | null): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const debounce = (key: string, ms: number, fn: () => void): void => {
    clearTimeout(timers.get(key));
    timers.set(key, globalThis.setTimeout(() => {
      timers.delete(key);
      fn();
    }, ms));
  };
  const st = store;

  st.watch((s) => s.settings, (settings) => debounce('save', SAVE_DEBOUNCE_MS, () => saveSettings(storage, settings)));

  // Plate editor follows the Plates tab.
  st.watch((s) => s.settings.tab, (tab, prev) => {
    if (prev === 'plates' && tab !== 'plates') host.exitEditor();
    if (tab === 'plates' && st.getState().runtime.worldLoaded) host.enterEditor();
  });
  st.watch((s) => s.runtime.editorActive, () => host.viewSync.legend());
  // The legend's "no climate" note says whether one is on its way.
  st.watch((s) => s.runtime.climate.phase, () => host.viewSync.legend());

  // Repaints.
  st.watch((s) => ({ layer: s.settings.view.layer, sea: s.settings.seaLevel, detail: s.settings.view.detail }), () => host.requestPaint('all'), { equal: shallowEqual });
  st.watch((s) => ({ b: s.settings.view.overlays.boundaries, c: s.settings.view.overlays.coastlines }), () => host.requestPaint('overlay'), { equal: shallowEqual });
  // Current particles over the currents layer replace its arrow glyphs (and give them back when off).
  // Layer changes repaint anyway (above): only a particle change on an unchanged layer needs one.
  st.watch((s) => ({ g: flowGlyphs(s), layer: s.settings.view.layer }), (v, prev) => {
    if (!prev || v.layer !== prev.layer) return;
    host.requestPaint('all');
    host.viewSync.legend();
  }, { equal: shallowEqual });
  st.watch((s) => s.runtime.month, () => {
    if (layerIsMonthly(st.getState().settings.view.layer)) host.requestPaint('all');
    host.viewSync.weather();
    host.viewSync.legend();
    host.hover.refresh();
  });

  // View properties.
  st.watch((s) => s.settings.view.view, (kind) => {
    const got = host.setViewKind(kind);
    if (got !== kind) st.dispatch({ type: 'patchView', patch: { view: got } });
  });
  st.watch((s) => ({
    l: s.settings.view.lighting, layer: s.settings.view.layer, m: s.runtime.month, tilt: s.settings.climate.axialTilt, view: s.settings.view.view,
    relief: s.settings.view.reliefScale, grat: s.settings.view.overlays.graticule, sea: s.settings.seaLevel,
    detail: s.settings.view.detail,
  }), () => host.viewSync.viewProps(), { equal: shallowEqual });
  st.watch((s) => ({
    p: s.settings.view.particles, n: s.settings.view.particleCount, c: s.settings.view.clouds, d: s.settings.view.cloudDensity,
    layer: s.settings.view.layer,
  }), () => host.viewSync.weather(), { equal: shallowEqual });
  st.watch((s) => s.settings.view.layer, (layer) => {
    // Flow particles follow a flow layer: wind streaks over the currents map (or the reverse) read as noise.
    const particles = st.getState().settings.view.particles;
    if (layer === 'currents' && particles === 'wind') st.dispatch({ type: 'patchView', patch: { particles: 'currents' } });
    if (layer === 'wind' && particles === 'currents') st.dispatch({ type: 'patchView', patch: { particles: 'wind' } });
    host.viewSync.legend();
    const rt = st.getState().runtime;
    // A climate-only layer without a climate: compute one rather than show a blank map.
    if (layerNeedsClimate(layer) && rt.climate.id === 0 && !host.climate.busy && rt.worldLoaded) host.climate.request('full', false);
  });

  // Simulation parameters.
  st.watch((s) => s.settings.tectonic, (params) => debounce('tectonic', TECTONIC_DEBOUNCE_MS, () => {
    if (st.getState().runtime.worldLoaded) host.sendTectonicParams(params);
  }));
  st.watch((s) => ({ speed: s.settings.speed, smooth: s.settings.smoothPlayback }), (v) => host.sendSpeed(v.speed, v.smooth), { equal: shallowEqual });

  // Climate parameters (incl. sea level): a quick fast climate, then the full one.
  st.watch((s) => {
    const c = s.settings.climate;
    return { t: c.axialTilt, s: c.solarMultiplier, o: c.globalTempOffset, m: c.moisture, oc: c.oceanCurrents, r: c.retrograde, sea: s.settings.seaLevel };
  }, () => debounce('climate', CLIMATE_PARAM_DEBOUNCE_MS, () => {
    const s = st.getState();
    if (s.runtime.climate.id !== 0 || s.settings.climate.live || host.climate.busy) host.climate.request('refine', true);
  }), { equal: shallowEqual });
  st.watch((s) => s.settings.climate.live, (live) => {
    const rt = st.getState().runtime;
    if (live && rt.worldLoaded && !rt.playing && (rt.climate.id === 0 || rt.climate.sourceSnapshotId !== rt.snapshotId)) {
      host.climate.request('full', false);
    }
  });

  // Seasons: advance the month on a timer.
  let seasonTimer: ReturnType<typeof setInterval> | undefined;
  st.watch((s) => ({ on: s.runtime.seasonsPlaying, secs: s.settings.seasonSeconds }), (v) => {
    clearInterval(seasonTimer);
    seasonTimer = undefined;
    if (v.on) seasonTimer = globalThis.setInterval(() => st.dispatch({ type: 'stepMonth', delta: 1 }), v.secs * 1000);
  }, { equal: shallowEqual });
}
