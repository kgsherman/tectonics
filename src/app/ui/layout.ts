/**
 * Application shell (SPEC.md §10 layout): header with tabs, left tab panels, center viewport with
 * Globe/Map toggle and layer quick-picker, right panel, bottom timeline.
 */
import type { UiContext } from '../commands';
import type { TabId } from '../state';
import { button, segmented } from './controls';
import { h } from './dom';
import { createHeader } from './header';
import { createLayerPicker } from './layerPicker';
import { createRightPanel, type RightPanel } from './rightPanel';
import { createClimateTab } from './tabs/climateTab';
import { createSimulateTab, type SimulateTab } from './tabs/simulateTab';
import { createViewTab } from './tabs/viewTab';
import { createWorldTab } from './tabs/worldTab';
import { createTimeline } from './timeline';
import { Viewport, type ViewportOptions } from './viewport';

export interface Layout {
  root: HTMLElement;
  viewport: Viewport;
  right: RightPanel;
  simulateTab: SimulateTab;
  /** Panel the plate editor renders its tools into. */
  editorHost: HTMLElement;
  tabPanels: Map<TabId, HTMLElement>;
}

export function buildLayout(ctx: UiContext, viewportOpts: ViewportOptions): Layout {
  const { store } = ctx;
  const viewport = new Viewport(viewportOpts);
  const right = createRightPanel(ctx);
  const simulateTab = createSimulateTab(ctx);
  const editorHost = h('div', { class: 'wg-editor-host' });

  const left = h('aside', { class: 'wg-left' });
  const tabPanels = new Map<TabId, HTMLElement>();
  const panels: Array<[TabId, HTMLElement]> = [
    ['world', createWorldTab(ctx)],
    ['plates', editorHost],
    ['simulate', simulateTab.el],
    ['climate', createClimateTab(ctx)],
    ['view', createViewTab(ctx)],
  ];
  for (const [id, el] of panels) {
    const panel = h('div', { class: 'wg-tabpanel', attrs: { role: 'tabpanel' } }, el);
    tabPanels.set(id, panel);
    left.appendChild(panel);
  }
  // Tabs share one scroll container: remember each tab's scroll position.
  const scrollTops = new Map<TabId, number>();
  store.watch((s) => s.settings.tab, (tab, prev) => {
    if (prev) scrollTops.set(prev, left.scrollTop);
    for (const [id, el] of tabPanels) el.hidden = id !== tab;
    left.scrollTop = scrollTops.get(tab) ?? 0;
  }, { immediate: true });

  const viewToggle = segmented({
    options: [{ value: 'globe', label: 'Globe', icon: 'globe', title: 'Globe (G)' }, { value: 'map', label: 'Map', icon: 'map', title: 'Map (M)' }],
    value: store.getState().settings.view.view,
    onChange: (v) => store.dispatch({ type: 'patchView', patch: { view: v } }),
  });
  store.watch((s) => s.settings.view.view, (v) => viewToggle.set(v));
  // Narrow windows: the side panels become slide-over drawers.
  const root = h('div', { class: 'wg-app' });
  const toggle = (cls: string): void => {
    root.classList.toggle(cls);
    root.classList.remove(cls === 'show-left' ? 'show-right' : 'show-left');
  };
  const leftBtn = button({ icon: 'panel', variant: 'ghost', title: 'Controls', onClick: () => toggle('show-left') });
  const rightBtn = button({ icon: 'panelRight', variant: 'ghost', title: 'Layers, legend & inspector', onClick: () => toggle('show-right') });
  viewport.toolbar.append(
    h('div', { class: 'wg-float wg-drawer-float is-left' }, leftBtn),
    h('div', { class: 'wg-float' }, viewToggle.el),
    createLayerPicker(ctx),
    h('div', { class: 'wg-float wg-drawer-float is-right' }, rightBtn),
  );
  // Interacting with the planet, or Escape, closes the drawers.
  const closeDrawers = (): void => root.classList.remove('show-left', 'show-right');
  viewport.host.addEventListener('pointerdown', closeDrawers);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawers();
  });

  root.append(createHeader(ctx), left, viewport.el, right.el, createTimeline(ctx));
  store.watch((s) => s.runtime.editorActive, (on) => root.classList.toggle('is-editing', on));
  return { root, viewport, right, simulateTab, editorHost, tabPanels };
}
