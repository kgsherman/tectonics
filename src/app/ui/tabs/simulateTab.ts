/** Simulate tab: tectonic parameters, statistics and the plate list. */
import type { TectonicParams } from '../../../core/types';
import type { UiContext } from '../../commands';
import { fmtMs, fmtMyr, fmtNum, fmtPercent, fmtPlateSpeed } from '../../format';
import { TECTONIC_SPECS } from '../../schema';
import { shownLandFraction } from '../../state';
import { shallowEqual } from '../../store';
import { button, hint, section, sectionWithAction, slider, statGrid, switchRow, type Control } from '../controls';
import { h, rgbCss, setChildren } from '../dom';
import { icon } from '../icons';
import type { PlateInfo } from '../../../core/types';

type NumKey = keyof typeof TECTONIC_SPECS;
const ORDER: NumKey[] = ['dt', 'speedScale', 'riftRate', 'maxPlates', 'subductionUplift', 'collisionUplift', 'erosion', 'hotspotActivity'];

export interface SimulateTab {
  el: HTMLElement;
  setPlates(plates: readonly PlateInfo[]): void;
}

export function createSimulateTab(ctx: UiContext): SimulateTab {
  const { store, commands } = ctx;
  const t0 = store.getState().settings.tectonic;
  const patch = (p: Partial<TectonicParams>): void => store.dispatch({ type: 'patchTectonic', patch: p });

  const sliders = ORDER.map((k) => [k, slider({ spec: TECTONIC_SPECS[k], value: t0[k], onChange: (v) => patch({ [k]: v }) })] as [NumKey, Control<number>]);
  const smooth = switchRow({
    label: 'Smooth fast playback',
    hint: 'At high speeds on big meshes, show ~8 frames/s instead of one per speed batch (the simulation runs a little slower while frames are painted). Off: full batches, maximum simulation rate.',
    value: store.getState().settings.smoothPlayback, onChange: (v) => store.dispatch({ type: 'setSmoothPlayback', value: v }),
  });
  store.watch((s) => s.settings.smoothPlayback, (v) => smooth.set(v));
  const merge = switchRow({ label: 'Merge colliding plates', hint: 'Plates in sustained continental collision fuse', value: t0.mergePlates, onChange: (v) => patch({ mergePlates: v }) });
  store.watch((s) => s.settings.tectonic, (t) => {
    for (const [k, c] of sliders) c.set(t[k]);
    merge.set(t.mergePlates);
  });

  const reset = button({ label: 'Reset', icon: 'reset', variant: 'ghost', title: 'Restore default parameters', onClick: () => store.dispatch({ type: 'resetTectonic' }) });
  const playBtn = button({ label: 'Play', icon: 'play', variant: 'primary', wide: true, onClick: () => commands.togglePlay() });
  const stepBtn = button({ label: 'Step', icon: 'step', variant: 'secondary', onClick: () => commands.step() });
  store.watch((s) => ({ playing: s.runtime.playing, loaded: s.runtime.worldLoaded, busy: s.runtime.tasks.some((t) => t.id === 'generate') }), (v) => {
    setChildren(playBtn, icon(v.playing ? 'pause' : 'play', 16), h('span', { text: v.playing ? 'Pause' : 'Play' }));
    playBtn.disabled = !v.loaded || v.busy;
    stepBtn.disabled = !v.loaded || v.busy;
  }, { immediate: true, equal: shallowEqual });

  const stats = statGrid([
    { key: 'time', label: 'Time' },
    { key: 'steps', label: 'Steps' },
    { key: 'plates', label: 'Plates' },
    { key: 'land', label: 'Land' },
    { key: 'cont', label: 'Continental crust' },
    { key: 'elev', label: 'Elevation range' },
    { key: 'mean', label: 'Mean elevation' },
    { key: 'cc', label: 'Continent made / lost' },
    { key: 'sub', label: 'Subducted cells' },
    { key: 'ridge', label: 'New ridge cells' },
    { key: 'events', label: 'Rifts · merges' },
    { key: 'perf', label: 'Step time' },
  ]);
  store.watch((s) => ({ st: s.runtime.stats, perf: s.runtime.perf, playing: s.runtime.playing, land: shownLandFraction(s.runtime) }), ({ st, perf, playing, land }) => {
    if (!st) return;
    stats.set('time', fmtMyr(st.time));
    stats.set('steps', fmtNum(st.steps));
    stats.set('plates', String(st.plateCount));
    stats.set('land', fmtPercent(land ?? st.landFraction, 1));
    stats.set('cont', fmtPercent(st.continentalFraction, 1));
    stats.set('elev', `${fmtNum(st.minElevation)} … ${fmtNum(st.maxElevation)} m`);
    stats.set('mean', `${fmtNum(st.meanElevation)} m`);
    stats.set('cc', `${fmtNum(st.continentalCreated)} / ${fmtNum(st.continentalDestroyed)}`);
    stats.set('sub', fmtNum(st.subductedCells));
    stats.set('ridge', fmtNum(st.ridgeCells));
    stats.set('events', `${st.rifts} · ${st.merges}`);
    stats.set('perf', playing ? `${fmtMs(perf.lastStepMs)} · ${fmtNum(perf.stepsPerSec, 1)}/s` : st.lastStepMs > 0 ? fmtMs(st.lastStepMs) : '—');
  }, { immediate: true, equal: shallowEqual });

  const plateList = h('div', { class: 'wg-plates' });
  let lastKey = '';
  const setPlates = (plates: readonly PlateInfo[]): void => {
    const sorted = [...plates].sort((a, b) => b.area - a.area);
    const key = sorted.map((p) => `${p.id}:${p.area.toFixed(3)}:${p.speed.toFixed(0)}`).join('|');
    if (key === lastKey) return;
    lastKey = key;
    setChildren(plateList, ...sorted.map((p) =>
      h('div', { class: 'wg-plate-row', title: `${p.name} — ${fmtPercent(p.continentalFraction)} continental` },
        h('i', { class: 'wg-swatch', style: { background: rgbCss(p.color) } }),
        h('span', { class: 'wg-plate-name', text: p.name }),
        h('span', { class: 'wg-readout', text: fmtPercent(p.area, 1) }),
        h('span', { class: 'wg-readout', text: fmtPlateSpeed(p.speed) }),
      )));
  };

  const el = h('div', null,
    h('div', { class: 'wg-panel-title', text: 'Simulation' }),
    h('div', { class: 'wg-panel-sub', text: 'Plate motion, subduction, collision, rifting and erosion.' }),
    h('section', { class: 'wg-section' }, h('div', { class: 'wg-row' }, playBtn, stepBtn), smooth.el,
      hint('Speed (steps per frame) and history are in the timeline below.')),
    sectionWithAction('Tectonics', reset, ...sliders.map(([, c]) => c.el), merge.el),
    section('Statistics', stats.el),
    section('Plates', plateList),
  );
  return { el, setPlates };
}
