/** Right panel: layer tiles, overlay switches (+ boundary key), legend and the hover inspector. */
import type { LayerId, LegendSpec, OverlayFlags } from '../../core/types';
import { BOUNDARY_LEGEND } from '../../render/legend';
import { LAYER_ORDER, layerNeedsClimate } from '../../worker/layerInfo';
import type { UiContext } from '../commands';
import { layerLabel, layerShortcut, layerShortLabel, LAYER_SWATCH } from '../layerMeta';
import { shallowEqual } from '../store';
import { section, switchRow } from './controls';
import { h, toggleClass } from './dom';
import { InspectorView } from './inspectorView';
import { renderLegend } from './legendView';

export interface RightPanel {
  el: HTMLElement;
  inspector: InspectorView;
  setLegend(spec: LegendSpec | null, note?: string): void;
}

const OVERLAYS: Array<{ key: keyof OverlayFlags; label: string; hint: string }> = [
  { key: 'boundaries', label: 'Plate boundaries', hint: 'Convergent (red), divergent (yellow), transform (white)' },
  { key: 'coastlines', label: 'Coastlines', hint: 'Shoreline traced on the displayed height map' },
  { key: 'graticule', label: 'Graticule', hint: 'Latitude/longitude grid every 15°' },
];

export function createRightPanel(ctx: UiContext): RightPanel {
  const { store } = ctx;

  const tiles = new Map<LayerId, HTMLButtonElement>();
  for (const layer of LAYER_ORDER) {
    const key = layerShortcut(layer);
    tiles.set(layer, h('button', {
      class: 'wg-layer-tile', title: `${layerLabel(layer)}${key ? ` (${key})` : ''}`, attrs: { type: 'button' },
      onClick: () => store.dispatch({ type: 'patchView', patch: { layer } }),
    }, h('i', { class: 'wg-layer-swatch', style: { background: LAYER_SWATCH[layer] } }), h('span', { text: layerShortLabel(layer) })));
  }
  store.watch((s) => ({ layer: s.settings.view.layer, hasClimate: s.runtime.climate.id !== 0 }), (v) => {
    for (const [layer, el] of tiles) {
      toggleClass(el, 'is-active', layer === v.layer);
      el.style.opacity = !v.hasClimate && layerNeedsClimate(layer) && layer !== v.layer ? '0.6' : '';
    }
  }, { immediate: true, equal: shallowEqual });

  const switches = OVERLAYS.map((o) =>
    switchRow({
      label: o.label, hint: o.hint, value: store.getState().settings.view.overlays[o.key],
      onChange: (value) => store.dispatch({ type: 'setOverlay', key: o.key, value }),
    }),
  );
  const boundaryKey = h('div');
  renderLegend(boundaryKey, BOUNDARY_LEGEND);
  store.watch((s) => s.settings.view.overlays, (ov) => {
    OVERLAYS.forEach((o, i) => switches[i].set(ov[o.key]));
    boundaryKey.hidden = !ov.boundaries;
  }, { immediate: true });

  const legendBody = h('div', { class: 'wg-field' });
  const legendNote = h('p', { class: 'wg-hint' });
  legendNote.hidden = true;
  const inspector = new InspectorView();

  // The inspector is docked at the bottom so it stays visible while hovering.
  const el = h('aside', { class: 'wg-right' },
    h('div', { class: 'wg-right-scroll' },
      section('Layers', h('div', { class: 'wg-layer-list' }, ...tiles.values())),
      section('Legend', legendBody, legendNote),
      section('Overlays', ...switches.map((s) => s.el), boundaryKey),
    ),
    h('div', { class: 'wg-right-dock' }, section('Inspector', inspector.el)),
  );

  return {
    el,
    inspector,
    setLegend(spec, note) {
      renderLegend(legendBody, spec);
      legendNote.hidden = !note;
      legendNote.textContent = note ?? '';
    },
  };
}
