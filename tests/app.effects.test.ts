/** Store → side-effect wiring (effects.ts) against a recording fake host, with fake timers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimateCoordinator } from '../src/app/climateCoordinator';
import { displaySettings, generateParams } from '../src/app/display';
import { wireStoreEffects, type EffectHost } from '../src/app/effects';
import type { HoverController } from '../src/app/hoverController';
import { SETTINGS_KEY, type KeyValueStorage } from '../src/app/settings';
import { DEFAULT_SETTINGS, initialState, reduce, type Action, type AppState } from '../src/app/state';
import { createStore, type Store } from '../src/app/store';
import type { ViewSync } from '../src/app/viewSync';

const stats = {
  time: 0, steps: 0, lastStepMs: 0, plateCount: 12, landFraction: 0.3, continentalFraction: 0.35, meanElevation: -2000,
  maxElevation: 5000, minElevation: -9000, continentalCreated: 0, continentalDestroyed: 0, subductedCells: 0, ridgeCells: 0,
  rifts: 0, merges: 0,
};

function setup() {
  const calls: string[] = [];
  const storage: KeyValueStorage & { data: Map<string, string> } = (() => {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  })();
  const store: Store<AppState, Action> = createStore(initialState(), reduce);
  let climateBusy = false;
  const host: EffectHost = {
    requestPaint: (parts) => calls.push(`paint:${parts}`),
    viewSync: {
      viewProps: () => calls.push('viewProps'),
      weather: () => calls.push('weather'),
      legend: () => calls.push('legend'),
    } as unknown as ViewSync,
    hover: { refresh: () => calls.push('hover') } as unknown as HoverController,
    climate: {
      request: (purpose: string, preempt: boolean) => calls.push(`climate:${purpose}:${preempt}`),
      get busy() {
        return climateBusy;
      },
    } as unknown as ClimateCoordinator,
    setViewKind: (kind) => {
      calls.push(`view:${kind}`);
      return kind === 'globe' ? 'map' : kind; // pretend WebGL is unavailable
    },
    enterEditor: () => calls.push('enterEditor'),
    exitEditor: () => calls.push('exitEditor'),
    sendTectonicParams: (p) => calls.push(`tectonic:${p.dt}`),
    sendSpeed: (n) => calls.push(`speed:${n}`),
  };
  wireStoreEffects(store, host, storage);
  const take = (): string[] => calls.splice(0);
  store.dispatch({ type: 'worldLoaded', meshN: 4000, seed: 1, time: 0, stats });
  take();
  return { store, take, storage, setBusy: (b: boolean) => (climateBusy = b) };
}

describe('store effects', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('repaints on layer / sea level / detail and overlay changes, and only monthly layers on month change', () => {
    const { store, take } = setup();
    store.dispatch({ type: 'patchView', patch: { layer: 'plates' } });
    expect(take()).toEqual(expect.arrayContaining(['paint:all', 'viewProps', 'weather', 'legend']));
    store.dispatch({ type: 'setOverlay', key: 'boundaries', value: true });
    expect(take()).toEqual(['paint:overlay']);
    store.dispatch({ type: 'setOverlay', key: 'graticule', value: true });
    expect(take()).toEqual(['viewProps']); // drawn by the view, no repaint
    store.dispatch({ type: 'setMonth', month: 3 });
    expect(take()).not.toContain('paint:all'); // plates are not monthly
    store.dispatch({ type: 'patchView', patch: { layer: 'satellite' } });
    take();
    store.dispatch({ type: 'setMonth', month: 4 });
    expect(take()).toEqual(expect.arrayContaining(['paint:all', 'weather', 'legend', 'hover', 'viewProps']));
  });

  it('asks for a climate when a climate-only layer is picked without one', () => {
    const { store, take, setBusy } = setup();
    store.dispatch({ type: 'patchView', patch: { layer: 'koppen' } });
    expect(take()).toContain('climate:full:false');
    store.dispatch({ type: 'climateDone', id: 5, sourceTime: 0, sourceSnapshotId: 1, fast: false, ms: 1, stats: {} });
    take();
    store.dispatch({ type: 'patchView', patch: { layer: 'temperature' } });
    expect(take()).not.toContain('climate:full:false');
    store.dispatch({ type: 'climateCleared' });
    setBusy(true);
    store.dispatch({ type: 'patchView', patch: { layer: 'sst' } });
    expect(take()).not.toContain('climate:full:false');
  });

  it('debounces climate parameter changes into one preemptive refine', () => {
    const { store, take } = setup();
    store.dispatch({ type: 'patchClimate', patch: { axialTilt: 30 } });
    store.dispatch({ type: 'patchClimate', patch: { axialTilt: 35 } });
    store.dispatch({ type: 'setSeaLevel', value: 100 });
    expect(take().filter((c) => c.startsWith('climate'))).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(take().filter((c) => c.startsWith('climate'))).toEqual(['climate:refine:true']);
    store.dispatch({ type: 'patchClimate', patch: { live: false } });
    store.dispatch({ type: 'patchClimate', patch: { moisture: 1.4 } });
    vi.advanceTimersByTime(1000);
    expect(take().filter((c) => c.startsWith('climate'))).toEqual([]); // no climate yet and auto off
  });

  it('forwards simulation parameters (debounced) and speed; falls back to the map view', () => {
    const { store, take } = setup();
    store.dispatch({ type: 'patchTectonic', patch: { dt: 2 } });
    store.dispatch({ type: 'patchTectonic', patch: { dt: 3 } });
    vi.advanceTimersByTime(500);
    expect(take()).toEqual(['tectonic:3']);
    store.dispatch({ type: 'setSpeed', speed: 10 });
    expect(take()).toEqual(['speed:10']);
    store.dispatch({ type: 'patchView', patch: { view: 'map' } });
    store.dispatch({ type: 'patchView', patch: { view: 'globe' } });
    expect(take()).toContain('view:globe');
    expect(store.getState().settings.view.view).toBe('map');
  });

  it('enters and leaves the editor with the Plates tab, advances seasons, persists settings', () => {
    const { store, take, storage } = setup();
    store.dispatch({ type: 'setTab', tab: 'plates' });
    expect(take()).toContain('enterEditor');
    store.dispatch({ type: 'setTab', tab: 'climate' });
    expect(take()).toContain('exitEditor');
    store.dispatch({ type: 'setSeasonsPlaying', playing: true });
    vi.advanceTimersByTime(DEFAULT_SETTINGS.seasonSeconds * 1000 * 3 + 10);
    expect(store.getState().runtime.month).toBe(3);
    store.dispatch({ type: 'setSeasonsPlaying', playing: false });
    vi.advanceTimersByTime(5000);
    expect(store.getState().runtime.month).toBe(3);
    vi.advanceTimersByTime(1000);
    expect(JSON.parse(storage.data.get(SETTINGS_KEY)!).tab).toBe('climate');
  });
});

describe('display mapping', () => {
  it('builds paint display settings and generator params from state', () => {
    const s = reduce(initialState(), { type: 'setMonth', month: 7 });
    const d = displaySettings(s);
    expect(d).toMatchObject({ layer: 'satellite', month: 7, seaLevel: 0, fullWidth: 2048, previewWidth: 1024 });
    expect(d.overlays).not.toBe(s.settings.view.overlays);
    const g = generateParams(s.settings.world);
    expect(g).not.toHaveProperty('meshN');
    expect(g.plateCount).toBe(s.settings.world.plateCount);
  });
});
