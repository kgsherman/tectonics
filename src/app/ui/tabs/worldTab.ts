/** World tab: random world generation parameters and the Generate action. */
import type { UiContext } from '../../commands';
import { fmtMyr, fmtNum, fmtPercent } from '../../format';
import { CONTINENT_MODES, MESH_RESOLUTIONS, WORLD_SPECS } from '../../schema';
import { shownLandFraction, worldParamsKey, type WorldSettings } from '../../state';
import { shallowEqual } from '../../store';
import { button, hint, section, seedField, segmented, slider, statGrid, type Control } from '../controls';
import { h, setText, toggleClass } from '../dom';

export function createWorldTab(ctx: UiContext): HTMLElement {
  const { store, commands } = ctx;
  const w0 = store.getState().settings.world;
  const patch = (p: Partial<WorldSettings>): void => store.dispatch({ type: 'patchWorld', patch: p });

  const seed = seedField({ value: w0.seed, onChange: (v) => patch({ seed: v }), onRandom: () => commands.randomizeSeed() });
  const mesh = segmented({
    options: MESH_RESOLUTIONS.map((n) => ({ value: n, label: `${n / 1000}k`, title: `${fmtNum(n)} cells` })),
    value: w0.meshN,
    onChange: (v) => patch({ meshN: v }),
    label: 'Mesh resolution',
  });
  const mode = segmented({ options: CONTINENT_MODES, value: w0.continentMode, onChange: (v) => patch({ continentMode: v }), label: 'Continents' });
  const sliders: Array<[keyof typeof WORLD_SPECS, Control<number>]> = [
    ['plateCount', slider({ spec: WORLD_SPECS.plateCount, value: w0.plateCount, onChange: (v) => patch({ plateCount: v }) })],
    ['continentalFraction', slider({ spec: WORLD_SPECS.continentalFraction, value: w0.continentalFraction, displayScale: 100, onChange: (v) => patch({ continentalFraction: v }) })],
    ['hotspotCount', slider({ spec: WORLD_SPECS.hotspotCount, value: w0.hotspotCount, onChange: (v) => patch({ hotspotCount: v }) })],
    ['plateSpeed', slider({ spec: WORLD_SPECS.plateSpeed, value: w0.plateSpeed, onChange: (v) => patch({ plateSpeed: v }) })],
    ['boundaryRoughness', slider({ spec: WORLD_SPECS.boundaryRoughness, value: w0.boundaryRoughness, onChange: (v) => patch({ boundaryRoughness: v }) })],
  ];
  store.watch((s) => s.settings.world, (w) => {
    seed.set(w.seed);
    mesh.set(w.meshN);
    mode.set(w.continentMode);
    for (const [k, c] of sliders) c.set(w[k]);
  });

  const generate = button({ label: 'Generate world', icon: 'sparkles', variant: 'primary', wide: true, onClick: () => commands.generate() });
  const changedNote = hint('Settings changed: generate to build a world with them.');
  const meshNote = hint('160k cells is sharper but slower to simulate.');
  store.watch((s) => ({
    busy: s.runtime.tasks.some((t) => t.id === 'generate'), want: s.settings.world.meshN, have: s.runtime.meshN,
    key: worldParamsKey(s.settings.world), built: s.runtime.worldParams,
  }), (v) => {
    generate.disabled = v.busy;
    setText(generate.lastElementChild as HTMLElement, v.busy ? 'Generating…' : 'Generate world');
    const changed = !v.busy && v.built !== '' && v.key !== v.built;
    changedNote.hidden = !changed;
    toggleClass(generate, 'is-pending', changed);
    meshNote.hidden = !(v.want === 160_000 && v.have !== v.want);
  }, { immediate: true, equal: shallowEqual });

  const stats = statGrid([
    { key: 'cells', label: 'Cells' },
    { key: 'plates', label: 'Plates' },
    { key: 'land', label: 'Land' },
    { key: 'cont', label: 'Continental crust' },
    { key: 'elev', label: 'Highest peak' },
    { key: 'time', label: 'Simulated time' },
  ]);
  store.watch((s) => ({ st: s.runtime.stats, n: s.runtime.meshN, seed: s.runtime.worldSeed, land: shownLandFraction(s.runtime) }), ({ st, n, land }) => {
    stats.set('cells', n ? fmtNum(n) : '—');
    stats.set('plates', st ? String(st.plateCount) : '—');
    stats.set('land', land !== null ? fmtPercent(land, 1) : '—');
    stats.set('cont', st ? fmtPercent(st.continentalFraction, 1) : '—');
    stats.set('elev', st ? `${fmtNum(st.maxElevation)} m` : '—');
    stats.set('time', st ? fmtMyr(st.time) : '—');
  }, { immediate: true, equal: shallowEqual });

  return h('div', null,
    h('div', { class: 'wg-panel-title', text: 'New world' }),
    h('div', { class: 'wg-panel-sub', text: 'Procedural plates, continents and hotspots.' }),
    section('Generation', seed.el, mesh.el, mode.el, ...sliders.map(([, c]) => c.el)),
    h('section', { class: 'wg-section' }, generate, changedNote, meshNote),
    section('Current world', stats.el),
  );
}
