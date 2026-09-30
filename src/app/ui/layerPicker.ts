/** Floating layer quick-picker (toolbar dropdown) grouped by Surface / Tectonics / Climate. */
import type { LayerId } from '../../core/types';
import { layerNeedsClimate } from '../../worker/layerInfo';
import type { UiContext } from '../commands';
import { LAYER_GROUPS, layerLabel, layerShortcut, LAYER_SWATCH } from '../layerMeta';
import { shallowEqual } from '../store';
import { h, setText, toggleClass } from './dom';

export function createLayerPicker(ctx: UiContext): HTMLElement {
  const { store } = ctx;
  const swatch = h('i', { class: 'wg-layer-swatch' });
  const name = h('span');
  const caret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  caret.setAttribute('viewBox', '0 0 12 12');
  caret.setAttribute('width', '12');
  caret.setAttribute('height', '12');
  caret.classList.add('wg-caret');
  caret.innerHTML = '<path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>';
  const btn = h('button', { class: 'wg-picker-btn', attrs: { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' } }, swatch, name, caret);

  const items = new Map<LayerId, HTMLButtonElement>();
  const needs = new Map<LayerId, HTMLElement>();
  const menu = h('div', { class: 'wg-menu', attrs: { role: 'listbox' } });
  for (const g of LAYER_GROUPS) {
    menu.appendChild(h('div', { class: 'wg-menu-group', text: g.title }));
    for (const layer of g.layers) {
      const need = h('span', { class: 'wg-need', text: 'needs climate' });
      const key = layerShortcut(layer);
      const item = h('button', {
        class: 'wg-layer-item', attrs: { type: 'button', role: 'option' },
        onClick: () => {
          store.dispatch({ type: 'patchView', patch: { layer } });
          close();
        },
      }, h('i', { class: 'wg-layer-swatch', style: { background: LAYER_SWATCH[layer] } }), h('span', { class: 'wg-layer-name', text: layerLabel(layer) }), need, key ? h('kbd', { text: key }) : null);
      items.set(layer, item);
      needs.set(layer, need);
      menu.appendChild(item);
    }
  }
  const el = h('div', { class: 'wg-picker wg-float' }, btn, menu);

  const onDoc = (e: PointerEvent): void => {
    if (!el.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  function open(): void {
    el.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
  }
  function close(): void {
    el.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
  }
  btn.addEventListener('click', () => (el.classList.contains('is-open') ? close() : open()));

  store.watch((s) => ({ layer: s.settings.view.layer, climate: s.runtime.climate.id !== 0 }), (v) => {
    swatch.style.background = LAYER_SWATCH[v.layer];
    setText(name, layerLabel(v.layer));
    for (const [layer, item] of items) {
      toggleClass(item, 'is-active', layer === v.layer);
      item.setAttribute('aria-selected', String(layer === v.layer));
      needs.get(layer)!.hidden = v.climate || !layerNeedsClimate(layer);
    }
  }, { immediate: true, equal: shallowEqual });
  return el;
}
