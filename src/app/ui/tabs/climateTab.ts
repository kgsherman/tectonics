/** Climate tab: planet parameters, sea level, compute / live climate, status and Köppen summary. */
import { KOPPEN_CLASSES } from '../../../climate/koppen';
import type { KoppenGroup } from '../../../core/types';
import type { UiContext } from '../../commands';
import { fmtMs, fmtMyr, fmtNum, fmtPercent, fmtTemp } from '../../format';
import { CLIMATE_SPECS, LIVE_INTERVAL_SPEC, SEA_LEVEL_SPEC, type ClimateNumKey } from '../../schema';
import { climateIsStale, type ClimateSettings } from '../../state';
import { shallowEqual } from '../../store';
import { button, hint, section, sectionWithAction, slider, statGrid, switchRow, type Control } from '../controls';
import { h, rgbCss, setChildren, setText } from '../dom';

const KEYS: ClimateNumKey[] = ['axialTilt', 'solarMultiplier', 'globalTempOffset', 'moisture', 'oceanCurrents'];
const GROUPS: Array<{ g: Exclude<KoppenGroup, 'ocean'>; name: string }> = [
  { g: 'A', name: 'Tropical' },
  { g: 'B', name: 'Arid' },
  { g: 'C', name: 'Temperate' },
  { g: 'D', name: 'Continental' },
  { g: 'E', name: 'Polar' },
];
/** Representative class color per group (first class of the group). */
const GROUP_COLOR = Object.fromEntries(GROUPS.map(({ g }) => [g, KOPPEN_CLASSES.find((k) => k.group === g)!.color]));

const STAGES: Record<string, string> = {
  input: 'Preparing input', dynamics: 'Energy balance & winds', hydrology: 'Moisture & precipitation', koppen: 'Köppen classes', done: 'Finishing',
};

export function createClimateTab(ctx: UiContext): HTMLElement {
  const { store, commands } = ctx;
  const c0 = store.getState().settings.climate;
  const patch = (p: Partial<ClimateSettings>): void => store.dispatch({ type: 'patchClimate', patch: p });

  const sliders = KEYS.map((k) => [k, slider({ spec: CLIMATE_SPECS[k], value: c0[k], onChange: (v) => patch({ [k]: v }) })] as [ClimateNumKey, Control<number>]);
  const sea = slider({ spec: SEA_LEVEL_SPEC, value: store.getState().settings.seaLevel, onChange: (v) => store.dispatch({ type: 'setSeaLevel', value: v }) });
  const retro = switchRow({ label: 'Retrograde rotation', hint: 'Planet spins the other way (reverses Coriolis)', value: c0.retrograde, onChange: (v) => patch({ retrograde: v }) });
  const live = switchRow({ label: 'Auto climate', hint: 'Fast updates while playing, full climate when paused', value: c0.live, onChange: (v) => patch({ live: v }) });
  const interval = slider({ spec: LIVE_INTERVAL_SPEC, value: c0.liveIntervalMyr, onChange: (v) => patch({ liveIntervalMyr: v }) });
  store.watch((s) => ({ c: s.settings.climate, sea: s.settings.seaLevel }), ({ c, sea: sl }) => {
    for (const [k, ctl] of sliders) ctl.set(c[k]);
    retro.set(c.retrograde);
    live.set(c.live);
    interval.set(c.liveIntervalMyr);
    interval.setDisabled?.(!c.live);
    sea.set(sl);
  }, { equal: shallowEqual });

  const compute = button({ label: 'Compute climate', icon: 'thermometer', variant: 'primary', wide: true, onClick: () => commands.computeClimate() });
  const reset = button({ label: 'Reset', icon: 'reset', variant: 'ghost', title: 'Earth-like defaults', onClick: () => store.dispatch({ type: 'resetClimate' }) });

  // Status card.
  const statusTitle = h('b');
  const statusSub = h('span', { class: 'wg-readout' });
  const bar = h('span');
  const progress = h('div', { class: 'wg-progress', style: { width: '100%' } }, bar);
  const staleNote = hint('The world changed since this climate was computed.', 'warn');
  const status = h('div', { class: 'wg-insp-block' }, h('div', { class: 'wg-field-head' }, statusTitle, statusSub), progress, staleNote);
  store.watch((s) => ({ c: s.runtime.climate, stale: climateIsStale(s.runtime), loaded: s.runtime.worldLoaded }), ({ c, stale, loaded }) => {
    compute.disabled = !loaded;
    progress.hidden = c.phase !== 'computing';
    bar.style.width = `${Math.round(c.progress * 100)}%`;
    staleNote.hidden = !(stale && c.phase !== 'computing');
    if (c.phase === 'computing') {
      setText(statusTitle, c.purpose === 'live' || c.purpose === 'scrub' ? 'Updating (fast)…' : 'Computing climate…');
      setText(statusSub, STAGES[c.stage] ?? c.stage);
    } else if (c.phase === 'error') {
      setText(statusTitle, 'Climate failed');
      setText(statusSub, c.error ?? '');
    } else if (c.phase === 'ready') {
      setText(statusTitle, `${c.fast ? 'Fast' : 'Full'} climate · ${fmtMyr(c.sourceTime)}`);
      setText(statusSub, fmtMs(c.ms));
    } else {
      setText(statusTitle, 'No climate yet');
      setText(statusSub, '');
    }
  }, { immediate: true, equal: shallowEqual });

  // Summary.
  const summary = statGrid([
    { key: 'global', label: 'Global mean' },
    { key: 'land', label: 'Land mean' },
    { key: 'precip', label: 'Precipitation' },
    { key: 'balance', label: 'Water balance error' },
  ]);
  const bars = h('div', { class: 'wg-bars' });
  store.watch((s) => s.runtime.climate.stats, (st) => {
    const has = Object.keys(st).length > 0;
    summary.set('global', has ? fmtTemp(st.globalMeanTemp) : '—');
    summary.set('land', has ? fmtTemp(st.landMeanTemp) : '—');
    summary.set('precip', has ? `${fmtNum(st.globalPrecipMm)} mm/yr` : '—');
    summary.set('balance', has ? fmtPercent(st.pMinusEError, 1) : '—');
    setChildren(bars, ...GROUPS.map(({ g, name }) => {
      const pct = has ? st[`koppenArea${g}`] ?? 0 : 0;
      return h('div', { class: 'wg-bar-row', title: `${name}: ${fmtNum(pct, 1)}% of land` },
        h('b', { text: g }),
        h('div', { class: 'wg-bar' }, h('span', { style: { width: `${Math.max(0, Math.min(100, pct))}%`, background: rgbCss(GROUP_COLOR[g]) } })),
        h('span', { class: 'wg-readout', text: has ? `${fmtNum(pct, 0)}%` : '—' }),
      );
    }));
  }, { immediate: true });

  return h('div', null,
    h('div', { class: 'wg-panel-title', text: 'Climate' }),
    h('div', { class: 'wg-panel-sub', text: 'Seasonal energy balance, winds, currents, rain and Köppen.' }),
    h('section', { class: 'wg-section' }, compute, status),
    sectionWithAction('Planet', reset, ...sliders.map(([, c]) => c.el), sea.el, retro.el),
    section('Live updates', live.el, interval.el, hint('While playing, a fast 2° climate is computed every interval without slowing the simulation.')),
    section('Summary', summary.el, h('div', { class: 'wg-section-title', text: 'Köppen groups (% of land)' }), bars),
  );
}
