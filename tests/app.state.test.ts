import { describe, expect, it } from 'vitest';
import { climateIsStale, DEFAULT_SETTINGS, initialState, normalizeMonth, reduce, stepMonth, type AppState } from '../src/app/state';
import { createStore, shallowEqual } from '../src/app/store';
import { loadSettings, sanitizeSettings, saveSettings, SETTINGS_KEY, type KeyValueStorage } from '../src/app/settings';
import { CLIMATE_SPECS, MESH_RESOLUTIONS, SPEEDS, TECTONIC_SPECS, WORLD_SPECS } from '../src/app/schema';
import { commandForKey, isTypingTarget } from '../src/app/keyboard';
import { ClimateQueue, liveClimateDue, type ClimateJob } from '../src/app/climateQueue';
import { resolveLighting } from '../src/app/lighting';
import { LAYER_ORDER } from '../src/worker/layerInfo';

const stats = {
  time: 0, steps: 0, lastStepMs: 0, plateCount: 12, landFraction: 0.3, continentalFraction: 0.35, meanElevation: -2000,
  maxElevation: 5000, minElevation: -9000, continentalCreated: 0, continentalDestroyed: 0, subductedCells: 0, ridgeCells: 0,
  rifts: 0, merges: 0,
};

describe('reducer', () => {
  it('clamps settings to their specs and rounds integers', () => {
    let s = initialState();
    s = reduce(s, { type: 'patchWorld', patch: { plateCount: 99.6, continentalFraction: -1, seed: -12.7 } });
    expect(s.settings.world.plateCount).toBe(WORLD_SPECS.plateCount.max);
    expect(s.settings.world.continentalFraction).toBe(WORLD_SPECS.continentalFraction.min);
    expect(s.settings.world.seed).toBe(12);
    s = reduce(s, { type: 'patchTectonic', patch: { dt: 100, maxPlates: 7.4 } });
    expect(s.settings.tectonic.dt).toBe(TECTONIC_SPECS.dt.max);
    expect(s.settings.tectonic.maxPlates).toBe(7);
    s = reduce(s, { type: 'patchClimate', patch: { axialTilt: 120, moisture: NaN } });
    expect(s.settings.climate.axialTilt).toBe(CLIMATE_SPECS.axialTilt.max);
    expect(s.settings.climate.moisture).toBe(CLIMATE_SPECS.moisture.min);
    s = reduce(s, { type: 'setSpeed', speed: 7 });
    expect(SPEEDS as readonly number[]).toContain(s.settings.speed);
    expect(s.settings.speed).toBe(5);
  });

  it('rejects unknown mesh resolutions', () => {
    const s = reduce(initialState(), { type: 'patchWorld', patch: { meshN: 12345 as never } });
    expect(MESH_RESOLUTIONS as readonly number[]).toContain(s.settings.world.meshN);
  });

  it('returns the same state for no-op actions', () => {
    const s = initialState();
    expect(reduce(s, { type: 'setTab', tab: s.settings.tab })).toBe(s);
    expect(reduce(s, { type: 'setOverlay', key: 'graticule', value: s.settings.view.overlays.graticule })).toBe(s);
    expect(reduce(s, { type: 'taskEnd', id: 'nope' })).toBe(s);
  });

  it('cycles months through the calendar and enters from the annual view', () => {
    expect(stepMonth(-1, 1)).toBe(0);
    expect(stepMonth(-1, -1)).toBe(11);
    expect(stepMonth(11, 1)).toBe(0);
    expect(stepMonth(0, -1)).toBe(11);
    expect(stepMonth(5, 14)).toBe(7);
    expect(normalizeMonth(15)).toBe(11);
    expect(normalizeMonth(-4)).toBe(-1);
    let s = initialState();
    s = reduce(s, { type: 'setSeasonsPlaying', playing: true });
    expect(s.runtime.month).toBe(0);
  });

  it('tracks tasks and climate status', () => {
    let s = initialState();
    s = reduce(s, { type: 'taskStart', id: 'gen', label: 'Generating' });
    s = reduce(s, { type: 'taskStart', id: 'gen', label: 'Generating again', progress: 0.1 });
    expect(s.runtime.tasks).toHaveLength(1);
    s = reduce(s, { type: 'taskProgress', id: 'gen', progress: 0.5 });
    expect(s.runtime.tasks[0]).toMatchObject({ label: 'Generating again', progress: 0.5 });
    s = reduce(s, { type: 'taskEnd', id: 'gen' });
    expect(s.runtime.tasks).toHaveLength(0);

    s = reduce(s, { type: 'worldLoaded', meshN: 4000, seed: 3, time: 0, stats });
    s = reduce(s, { type: 'snapshot', snapshotId: 42, stats });
    s = reduce(s, { type: 'climateStarted', purpose: 'full' });
    expect(s.runtime.climate.phase).toBe('computing');
    s = reduce(s, { type: 'climateProgress', stage: 'dynamics', fraction: 2 });
    expect(s.runtime.climate.progress).toBe(1);
    s = reduce(s, { type: 'climateDone', id: 9, sourceTime: 0, sourceSnapshotId: 42, fast: false, ms: 10, stats: {} });
    expect(s.runtime.climate.phase).toBe('ready');
    expect(climateIsStale(s.runtime)).toBe(false);
    s = reduce(s, { type: 'snapshot', snapshotId: 43, stats });
    expect(climateIsStale(s.runtime)).toBe(true);
    s = reduce(s, { type: 'climateIdle' });
    expect(s.runtime.climate.phase).toBe('ready');
    s = reduce(s, { type: 'climateCleared' });
    expect(s.runtime.climate.phase).toBe('none');
  });
});

describe('store', () => {
  it('notifies subscribers and watchers only on change, in order', () => {
    const store = createStore<AppState, Parameters<typeof reduce>[1]>(initialState(), reduce);
    const seen: string[] = [];
    store.watch((s) => s.settings.tab, (tab, prev) => seen.push(`${prev}->${tab}`));
    store.watch((s) => s.settings.view.layer, (l) => {
      seen.push(`layer ${l}`);
      // Nested dispatch is queued, not re-entrant.
      if (l === 'plates') store.dispatch({ type: 'setTab', tab: 'view' });
    });
    store.dispatch({ type: 'setTab', tab: 'climate' });
    store.dispatch({ type: 'setTab', tab: 'climate' });
    store.dispatch({ type: 'patchView', patch: { layer: 'plates' } });
    expect(seen).toEqual(['world->climate', 'layer plates', 'climate->view']);
  });

  it('shallowEqual compares one level', () => {
    expect(shallowEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(shallowEqual([1, 2], [1, 2])).toBe(true);
    expect(shallowEqual({ a: {} }, { a: {} })).toBe(false);
  });
});

describe('settings persistence', () => {
  const memory = (): KeyValueStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  it('round-trips', () => {
    const st = memory();
    const s = { ...DEFAULT_SETTINGS, seaLevel: 120, speed: 10, view: { ...DEFAULT_SETTINGS.view, layer: 'koppen' as const } };
    expect(saveSettings(st, s)).toBe(true);
    expect(loadSettings(st)).toEqual(s);
  });

  it('sanitizes garbage field by field', () => {
    const s = sanitizeSettings({
      tab: 'nope', seaLevel: 'high', speed: 3,
      world: { plateCount: 500, meshN: 7, continentMode: 'pangaea', seed: 5 },
      view: { layer: 'bogus', overlays: { boundaries: 'yes', graticule: true }, lighting: 'sun', particleCount: 1e9 },
      climate: { retrograde: 1, axialTilt: 45 },
    });
    expect(s.tab).toBe(DEFAULT_SETTINGS.tab);
    expect(s.seaLevel).toBe(0);
    expect(s.speed).toBe(DEFAULT_SETTINGS.speed);
    expect(s.world.plateCount).toBe(30);
    expect(s.world.meshN).toBe(DEFAULT_SETTINGS.world.meshN);
    expect(s.world.continentMode).toBe('scattered');
    expect(s.world.seed).toBe(5);
    expect(s.view.layer).toBe('satellite');
    expect(s.view.overlays).toEqual({ boundaries: false, graticule: true, coastlines: false });
    expect(s.view.lighting).toBe('sun');
    expect(s.view.particleCount).toBe(16000);
    expect(s.climate.retrograde).toBe(false);
    expect(s.climate.axialTilt).toBe(45);
    expect(sanitizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('survives throwing or corrupt storage', () => {
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS);
    expect(saveSettings(throwing, DEFAULT_SETTINGS)).toBe(false);
    const st = memory();
    st.data.set(SETTINGS_KEY, '{not json');
    expect(loadSettings(st)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('keyboard', () => {
  const ctx = { editorActive: false };
  it('maps the documented shortcuts', () => {
    expect(commandForKey({ key: ' ', code: 'Space' }, ctx)).toEqual({ kind: 'togglePlay' });
    expect(commandForKey({ key: 'g' }, ctx)).toEqual({ kind: 'view', view: 'globe' });
    expect(commandForKey({ key: 'M' }, ctx)).toEqual({ kind: 'view', view: 'map' });
    expect(commandForKey({ key: '[' }, ctx)).toEqual({ kind: 'month', delta: -1 });
    expect(commandForKey({ key: ']' }, ctx)).toEqual({ kind: 'month', delta: 1 });
    for (let i = 1; i <= 9; i++) expect(commandForKey({ key: String(i) }, ctx)).toEqual({ kind: 'layer', layer: LAYER_ORDER[i - 1] });
    expect(commandForKey({ key: 'g', ctrlKey: true }, ctx)).toBeNull();
    expect(commandForKey({ key: 'x' }, ctx)).toBeNull();
  });

  it('leaves Space and digits to the editor while it is active', () => {
    const ed = { editorActive: true };
    expect(commandForKey({ key: ' ', code: 'Space' }, ed)).toBeNull();
    expect(commandForKey({ key: '3' }, ed)).toBeNull();
    expect(commandForKey({ key: 'g' }, ed)).toEqual({ kind: 'view', view: 'globe' });
  });

  it('ignores typing targets', () => {
    const fake = (tagName: string, type?: string) => ({ tagName, type, isContentEditable: false }) as unknown as EventTarget;
    expect(isTypingTarget(fake('INPUT', 'number'))).toBe(true);
    expect(isTypingTarget(fake('INPUT', 'range'))).toBe(false);
    expect(isTypingTarget(fake('TEXTAREA'))).toBe(true);
    expect(isTypingTarget(fake('BUTTON'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('climate queue', () => {
  const job = (purpose: ClimateJob['purpose'], then?: ClimateJob): ClimateJob => ({ purpose, fast: purpose !== 'full', gridW: 180, gridH: 90, then });

  it('runs one job, keeps the latest pending, preempts on demand', () => {
    const q = new ClimateQueue();
    const a = job('live');
    expect(q.submit(a, false)).toEqual({ action: 'start', job: a });
    expect(q.submit(job('live'), false)).toEqual({ action: 'queued' });
    const c = job('live');
    expect(q.submit(c, false)).toEqual({ action: 'queued' });
    expect(q.pending).toBe(c);
    expect(q.finish()).toBe(c);
    expect(q.running).toBe(c);
    const d = job('full');
    expect(q.submit(d, true)).toEqual({ action: 'cancelAndStart', job: d });
    expect(q.pending).toBeNull();
    expect(q.finish()).toBeNull();
    expect(q.idle).toBe(true);
  });

  it('chains follow-ups unless a newer job is waiting', () => {
    const q = new ClimateQueue();
    const full = job('full');
    q.submit(job('refine', full), true);
    expect(q.finish()).toBe(full);
    expect(q.finish()).toBeNull();

    const full2 = job('full');
    q.submit(job('refine', full2), false);
    const newer = job('live');
    q.submit(newer, false);
    expect(q.finish()).toBe(newer);
    expect(q.clear()).toBe(true);
    expect(q.clear()).toBe(false);
  });

  it('live climate is due every interval', () => {
    expect(liveClimateDue(0, null, 10)).toBe(true);
    expect(liveClimateDue(9, 0, 10)).toBe(false);
    expect(liveClimateDue(10, 0, 10)).toBe(true);
    expect(liveClimateDue(3, 50, 10)).toBe(true); // history branched backwards
  });
});

describe('lighting', () => {
  it('auto: data layers flat, satellite relief (annual) or sun (monthly)', () => {
    expect(resolveLighting('auto', 'temperature', 3, 23.44)).toEqual({ mode: 'flat' });
    expect(resolveLighting('auto', 'elevation', 3, 23.44)).toEqual({ mode: 'relief' });
    expect(resolveLighting('auto', 'satellite', -1, 23.44)).toEqual({ mode: 'relief' });
    const jun = resolveLighting('auto', 'satellite', 5, 23.44);
    expect(jun.mode).toBe('sun');
    if (jun.mode === 'sun') expect((jun.declination * 180) / Math.PI).toBeGreaterThan(22);
    expect(resolveLighting('flat', 'satellite', 5, 23.44)).toEqual({ mode: 'flat' });
    const dec = resolveLighting('sun', 'plates', 11, 23.44);
    if (dec.mode === 'sun') expect((dec.declination * 180) / Math.PI).toBeLessThan(-22);
  });
});
