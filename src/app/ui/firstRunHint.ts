/**
 * First-run hint floating over the viewport: "Drag to rotate · Space to play · Plates tab to draw
 * your own". Each tip ticks off when the user does it; the hint fades out once all are done or when
 * dismissed (×, Escape), and never comes back (localStorage). Hidden while loading, playing or
 * editing plates so it never covers what the user is watching.
 */
import type { UiContext } from '../commands';
import { hintComplete, loadHintState, markHintDone, saveHintState, type HintState, type HintStep } from '../onboarding';
import type { KeyValueStorage } from '../settings';
import { shallowEqual } from '../store';
import { h, toggleClass } from './dom';
import { icon } from './icons';

/** Delay before the hint appears once the first world is on screen. */
const SHOW_DELAY_MS = 900;
/** Time the completed hint stays (all ticks visible) before fading out. */
const DONE_LINGER_MS = 1600;

export function createFirstRunHint(ctx: UiContext, storage: KeyValueStorage | null, viewHost: HTMLElement): HTMLElement {
  const { store } = ctx;
  let state: HintState = loadHintState(storage);

  const item = (step: HintStep, ...content: Array<Node | string>): HTMLElement =>
    h('li', { class: 'wg-onb-item', dataset: { step } }, h('span', { class: 'wg-onb-tick' }, icon('check', 12)), h('span', { class: 'wg-onb-text' }, ...content));
  const platesLink = h('button', {
    class: 'wg-onb-link', text: 'Plates', attrs: { type: 'button' }, title: 'Open the plate editor',
    onClick: () => store.dispatch({ type: 'setTab', tab: 'plates' }),
  });
  const items: Record<HintStep, HTMLElement> = {
    rotate: item('rotate', h('b', { text: 'Drag' }), ' to rotate'),
    play: item('play', h('kbd', { text: 'Space' }), ' to play'),
    plates: item('plates', platesLink, ' tab to draw your own'),
  };
  const close = h('button', {
    class: 'wg-onb-close', title: 'Dismiss', attrs: { type: 'button', 'aria-label': 'Dismiss tips' },
    onClick: () => dismiss(),
  }, icon('close', 14));
  const el = h('div', { class: 'wg-onb wg-float', attrs: { role: 'note', 'aria-label': 'Getting started' } },
    h('ul', null, items.rotate, h('li', { class: 'wg-onb-sep', attrs: { 'aria-hidden': 'true' } }), items.play, h('li', { class: 'wg-onb-sep', attrs: { 'aria-hidden': 'true' } }), items.plates),
    close,
  );
  el.hidden = true;
  if (hintComplete(state)) return el;

  let ready = false;
  let finished = false;
  let revealTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanups: Array<() => void> = [];

  const render = (): void => {
    for (const step of Object.keys(items) as HintStep[]) toggleClass(items[step], 'is-done', state.done.includes(step));
  };
  const update = (): void => {
    const rt = store.getState().runtime;
    const show = ready && !finished && !rt.playing && !rt.editorActive && !rt.tasks.some((t) => t.id === 'generate');
    toggleClass(el, 'is-visible', show);
  };
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearTimeout(revealTimer);
    toggleClass(el, 'is-visible', false);
    for (const c of cleanups.splice(0)) c();
    globalThis.setTimeout(() => el.remove(), 400);
  };
  const dismiss = (): void => {
    state = { ...state, dismissed: true };
    saveHintState(storage, state);
    finish();
  };
  const done = (step: HintStep): void => {
    if (finished) return;
    const next = markHintDone(state, step);
    if (next === state) return;
    state = next;
    saveHintState(storage, state);
    render();
    if (hintComplete(state)) globalThis.setTimeout(finish, DONE_LINGER_MS);
  };

  // Show once the first world is on screen.
  cleanups.push(store.watch((s) => s.runtime.worldLoaded && !s.runtime.tasks.some((t) => t.id === 'generate'), (loaded) => {
    if (!loaded || ready) return;
    revealTimer = globalThis.setTimeout(() => {
      ready = true;
      el.hidden = false;
      update();
    }, SHOW_DELAY_MS);
  }, { immediate: true }));
  cleanups.push(store.watch((s) => ({ p: s.runtime.playing, e: s.runtime.editorActive, t: s.runtime.tasks }), update, { equal: shallowEqual }));
  cleanups.push(store.watch((s) => s.runtime.playing, (p) => p && done('play')));
  cleanups.push(store.watch((s) => s.settings.tab, (t) => t === 'plates' && done('plates')));

  // Rotating the planet: a drag on the view.
  const onMove = (e: PointerEvent): void => {
    if (e.buttons) done('rotate');
  };
  viewHost.addEventListener('pointermove', onMove);
  cleanups.push(() => viewHost.removeEventListener('pointermove', onMove));
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && el.classList.contains('is-visible')) dismiss();
  };
  window.addEventListener('keydown', onKey);
  cleanups.push(() => window.removeEventListener('keydown', onKey));
  render();
  return el;
}
