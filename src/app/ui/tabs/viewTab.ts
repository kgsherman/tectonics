/** View tab: projection, lighting, relief, overlays, weather (particles, clouds), seasons, export, shortcuts. */
import type { OverlayFlags } from '../../../core/types';
import type { UiContext } from '../../commands';
import { SEASON_SECONDS_SPEC, VIEW_SPECS } from '../../schema';
import type { LightingChoice, ParticleChoice, ViewKind, ViewSettings } from '../../state';
import { shallowEqual } from '../../store';
import { button, hint, section, segmented, slider, switchRow } from '../controls';
import { h } from '../dom';

const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'Play / pause'],
  ['.', 'Step once'],
  ['G / M', 'Globe / map'],
  ['1 – 9', 'Layers'],
  ['[  ]', 'Previous / next month'],
  ['S', 'Play seasons'],
];

export function createViewTab(ctx: UiContext): HTMLElement {
  const { store, commands } = ctx;
  const v0 = store.getState().settings.view;
  const patch = (p: Partial<Omit<ViewSettings, 'overlays'>>): void => store.dispatch({ type: 'patchView', patch: p });

  const kind = segmented<ViewKind>({
    label: 'Projection',
    options: [{ value: 'globe', label: 'Globe', icon: 'globe' }, { value: 'map', label: 'Map', icon: 'map' }],
    value: v0.view, onChange: (v) => patch({ view: v }),
  });
  const lighting = segmented<LightingChoice>({
    label: 'Lighting',
    options: [
      { value: 'auto', label: 'Auto', title: 'Flat for data layers; relief for satellite and elevation, lit by the month’s sun on the globe' },
      { value: 'flat', label: 'Flat', title: 'Exact legend colors' },
      { value: 'relief', label: 'Relief', title: 'Camera-relative light with relief shading' },
      { value: 'sun', label: 'Sun', title: 'Day/night with the month’s solar declination' },
    ],
    value: v0.lighting, onChange: (v) => patch({ lighting: v }),
  });
  const relief = slider({ spec: VIEW_SPECS.reliefScale, value: v0.reliefScale, onInput: (v) => patch({ reliefScale: v }) });
  const detail = slider({ spec: VIEW_SPECS.detail, value: v0.detail, onChange: (v) => patch({ detail: v }) });

  const overlayKeys: Array<[keyof OverlayFlags, string]> = [['boundaries', 'Plate boundaries'], ['coastlines', 'Coastlines'], ['graticule', 'Graticule']];
  const overlays = overlayKeys.map(([key, label]) =>
    switchRow({ label, value: v0.overlays[key], onChange: (value) => store.dispatch({ type: 'setOverlay', key, value }) }));

  const particles = segmented<ParticleChoice>({
    label: 'Flow particles',
    options: [{ value: 'off', label: 'Off' }, { value: 'wind', label: 'Wind' }, { value: 'currents', label: 'Currents' }],
    value: v0.particles, onChange: (v) => patch({ particles: v }),
  });
  const count = slider({ spec: VIEW_SPECS.particleCount, value: v0.particleCount, onChange: (v) => patch({ particleCount: v }) });
  const clouds = switchRow({ label: 'Clouds', hint: 'Cloud cover from the climate, drifting with the wind', value: v0.clouds, onChange: (v) => patch({ clouds: v }) });
  const density = slider({ spec: VIEW_SPECS.cloudDensity, value: v0.cloudDensity, onChange: (v) => patch({ cloudDensity: v }) });
  const seasonLen = slider({ spec: SEASON_SECONDS_SPEC, value: store.getState().settings.seasonSeconds, onChange: (v) => store.dispatch({ type: 'setSeasonSeconds', value: v }) });
  const seasonsBtn = button({ label: 'Play seasons', icon: 'calendar', variant: 'secondary', wide: true, onClick: () => commands.toggleSeasons() });

  const weatherNote = hint('Particles and clouds need a climate (Climate tab). Clouds show on the satellite layer.');
  weatherNote.hidden = store.getState().runtime.climate.id !== 0;
  store.watch((s) => ({ v: s.settings.view, secs: s.settings.seasonSeconds, seasons: s.runtime.seasonsPlaying, climate: s.runtime.climate.id !== 0 }), (x) => {
    kind.set(x.v.view);
    lighting.set(x.v.lighting);
    relief.set(x.v.reliefScale);
    detail.set(x.v.detail);
    overlayKeys.forEach(([key], i) => overlays[i].set(x.v.overlays[key]));
    particles.set(x.v.particles);
    count.set(x.v.particleCount);
    count.setDisabled?.(x.v.particles === 'off');
    clouds.set(x.v.clouds);
    density.set(x.v.cloudDensity);
    density.setDisabled?.(!x.v.clouds);
    seasonLen.set(x.secs);
    seasonsBtn.classList.toggle('is-active', x.seasons);
    seasonsBtn.lastElementChild!.textContent = x.seasons ? 'Stop seasons' : 'Play seasons';
    weatherNote.hidden = x.climate;
  }, { equal: shallowEqual });

  const exportMap = button({ label: 'Map PNG', icon: 'download', variant: 'secondary', title: 'Equirectangular image of the current layer (2048×1024)', onClick: () => commands.exportMap() });
  const shot = button({ label: 'Screenshot', icon: 'camera', variant: 'secondary', title: 'PNG of the current view', onClick: () => commands.exportScreenshot() });

  return h('div', null,
    h('div', { class: 'wg-panel-title', text: 'View' }),
    h('div', { class: 'wg-panel-sub', text: 'How the planet is drawn.' }),
    section('Display', kind.el, lighting.el, relief.el, detail.el),
    section('Overlays', ...overlays.map((o) => o.el)),
    section('Weather', particles.el, count.el, clouds.el, density.el, weatherNote),
    section('Seasons', seasonLen.el, seasonsBtn),
    section('Export', h('div', { class: 'wg-row' }, exportMap, shot)),
    section('Keyboard', h('dl', { class: 'wg-keys' }, ...SHORTCUTS.flatMap(([k, label]) => [h('dt', null, h('kbd', { text: k })), h('dd', { text: label })]))),
  );
}
