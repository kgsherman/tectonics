/** Header: brand, tab bar, world/climate status chips and the running-task indicator. */
import type { UiContext } from '../commands';
import { fmtMyr, fmtPercent } from '../format';
import { displayedTime, TABS, type AppState } from '../state';
import { shallowEqual } from '../store';
import { h, setText, toggleClass } from './dom';

export function createHeader(ctx: UiContext): HTMLElement {
  const { store } = ctx;
  const tabs = TABS.map((t) =>
    h('button', {
      class: 'wg-tab', text: t.label, attrs: { type: 'button', role: 'tab' },
      onClick: () => store.dispatch({ type: 'setTab', tab: t.id }),
    }),
  );
  store.watch((s) => s.settings.tab, (tab) => {
    TABS.forEach((t, i) => {
      toggleClass(tabs[i], 'is-active', t.id === tab);
      tabs[i].setAttribute('aria-selected', String(t.id === tab));
      // Roving tab index: Tab enters the tab bar once, arrows move within it.
      tabs[i].tabIndex = t.id === tab ? 0 : -1;
    });
  }, { immediate: true });
  tabs.forEach((el, i) => el.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const j = (i + d + TABS.length) % TABS.length;
    store.dispatch({ type: 'setTab', tab: TABS[j].id });
    tabs[j].focus();
  }));

  // World chip.
  const worldDot = h('i', { class: 'wg-dot' });
  const worldText = h('span', { class: 'wg-num' });
  const worldChip = h('button', {
    class: 'wg-chip', title: 'Simulation time · plates · land (open Simulate)', attrs: { type: 'button' },
    onClick: () => store.dispatch({ type: 'setTab', tab: 'simulate' }),
  }, worldDot, worldText);
  store.watch((s) => ({ loaded: s.runtime.worldLoaded, time: displayedTime(s.runtime), playing: s.runtime.playing, stats: s.runtime.stats, kf: s.runtime.viewingKeyframe }), (v) => {
    toggleClass(worldDot, 'is-live', v.playing);
    if (!v.loaded || !v.stats) {
      setText(worldText, 'No world');
      return;
    }
    // Stats describe the live simulation; while scrubbing only the viewed time is shown.
    setText(worldText, v.kf !== null
      ? `Viewing ${fmtMyr(v.time)} · history`
      : `${fmtMyr(v.time)} · ${v.stats.plateCount} plates · ${fmtPercent(v.stats.landFraction)} land`);
  }, { immediate: true, equal: shallowEqual });

  // Climate chip.
  const climDot = h('i', { class: 'wg-dot' });
  const climText = h('span');
  const climChip = h('button', {
    class: 'wg-chip is-optional', title: 'Climate model status (open Climate)', attrs: { type: 'button' },
    onClick: () => store.dispatch({ type: 'setTab', tab: 'climate' }),
  }, climDot, climText);
  const climLabel = (s: AppState): string => {
    const c = s.runtime.climate;
    if (c.phase === 'computing') return `Climate ${Math.round(c.progress * 100)}%`;
    if (c.phase === 'error') return 'Climate failed';
    if (c.phase === 'none') return 'No climate';
    return c.fast ? 'Climate (fast)' : 'Climate ready';
  };
  store.watch((s) => `${s.runtime.climate.phase}|${climLabel(s)}`, () => {
    const c = store.getState().runtime.climate;
    toggleClass(climDot, 'is-busy', c.phase === 'computing');
    toggleClass(climDot, 'is-live', c.phase === 'ready');
    toggleClass(climDot, 'is-error', c.phase === 'error');
    setText(climText, climLabel(store.getState()));
  }, { immediate: true });

  // Tasks.
  const taskLabel = h('span', { class: 'wg-tasks-label' });
  const bar = h('span');
  const progress = h('span', { class: 'wg-progress' }, bar);
  const tasks = h('div', { class: 'wg-tasks', attrs: { 'aria-live': 'polite' } }, h('span', { class: 'wg-spinner' }), taskLabel, progress);
  store.watch((s) => s.runtime.tasks, (list) => {
    toggleClass(tasks, 'is-visible', list.length > 0);
    if (!list.length) return;
    const t = list[list.length - 1];
    setText(taskLabel, list.length > 1 ? `${t.label} (+${list.length - 1})` : t.label);
    toggleClass(progress, 'is-indeterminate', t.progress === null);
    bar.style.width = t.progress === null ? '' : `${Math.round(t.progress * 100)}%`;
  }, { immediate: true });

  return h('header', { class: 'wg-header' },
    h('div', { class: 'wg-brand' }, h('span', { class: 'wg-brand-mark' }), h('span', { class: 'wg-brand-name', text: 'Worldgen' }), h('small', { text: 'planet generator' })),
    h('nav', { class: 'wg-tabs', attrs: { role: 'tablist' } }, ...tabs),
    h('div', { class: 'wg-header-right' }, tasks, climChip, worldChip),
  );
}
