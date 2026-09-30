/**
 * Bottom timeline: play/pause, step, speed (steps per frame), simulation time, history scrubber
 * over the keyframes (with "back to live" and "play from here"), month slider and play seasons.
 */
import type { UiContext } from '../commands';
import { fmtMyr, fmtNum, monthLabel } from '../format';
import { SPEEDS } from '../schema';
import { displayedTime } from '../state';
import { shallowEqual } from '../store';
import { button, segmented } from './controls';
import { h, setChildren, setText, toggleClass } from './dom';
import { icon } from './icons';

export function createTimeline(ctx: UiContext): HTMLElement {
  const { store, commands } = ctx;

  /* Transport */
  const play = button({ icon: 'play', variant: 'secondary', title: 'Play / pause (Space)', onClick: () => commands.togglePlay() });
  play.classList.add('wg-play');
  const step = button({ icon: 'step', variant: 'ghost', title: 'Step (.)', onClick: () => commands.step() });
  const speed = segmented({
    options: SPEEDS.map((s) => ({ value: s, label: `${s}×`, title: `Speed ${s}×: ${s} simulation step${s > 1 ? 's' : ''} per frame` })),
    value: store.getState().settings.speed,
    onChange: (v) => store.dispatch({ type: 'setSpeed', speed: v }),
  });
  speed.el.classList.add('wg-tl-speed');
  store.watch((s) => s.settings.speed, (v) => speed.set(v));

  const timeMain = h('b', { text: '0.0 Myr' });
  const timeSub = h('span', { text: '' });
  const time = h('div', { class: 'wg-time' }, timeMain, timeSub);

  store.watch((s) => ({
    playing: s.runtime.playing, loaded: s.runtime.worldLoaded, time: displayedTime(s.runtime), live: s.runtime.time,
    viewing: s.runtime.viewingKeyframe !== null, perf: s.runtime.perf, dt: s.settings.tectonic.dt, editing: s.runtime.editorActive,
    busy: s.runtime.tasks.some((t) => t.id === 'generate'),
  }), (v) => {
    setChildren(play, icon(v.playing ? 'pause' : 'play', 16));
    toggleClass(play, 'is-playing', v.playing);
    play.disabled = !v.loaded || v.editing || v.busy;
    step.disabled = !v.loaded || v.editing || v.busy;
    play.title = v.playing ? 'Pause (Space)' : 'Play (Space)';
    speed.setDisabled?.(!v.loaded);
    setText(timeMain, fmtMyr(v.time));
    setText(timeSub, v.playing
      ? `${fmtNum(v.perf.stepsPerSec * v.dt, 1)} Myr/s · ${fmtNum(v.perf.framesPerSec, 0)} fps`
      : v.viewing ? `history · live ${fmtMyr(v.live)}` : `${fmtNum(v.dt, v.dt % 1 ? 2 : 0)} Myr per step`);
  }, { immediate: true, equal: shallowEqual });

  /* History scrubber */
  const range = h('input', { class: 'wg-range', attrs: { type: 'range', min: 0, max: 0, step: 1, 'aria-label': 'History' } });
  const ticks = h('div', { class: 'wg-ticks' });
  const histLabel = h('span', { class: 'wg-num', text: 'History' });
  const liveBtn = button({ label: 'Live', icon: 'history', variant: 'ghost', title: 'Back to the live simulation', onClick: () => commands.showKeyframe(null) });
  const branchBtn = button({ label: 'Play from here', icon: 'branch', variant: 'ghost', title: 'Discard later history and continue from this keyframe', onClick: () => commands.playFromKeyframe() });
  const history = h('div', { class: 'wg-history' },
    h('div', { class: 'wg-history-head' }, histLabel, h('span', { class: 'wg-row', style: { gap: '4px', flex: '0' } }, branchBtn, liveBtn)),
    h('div', { class: 'wg-history-track' }, ticks, range),
  );
  /** Scrubber positions: 0..count-1 = keyframes, count = live. */
  const onScrub = (): void => {
    const s = store.getState().runtime;
    const i = Number(range.value);
    range.style.setProperty('--pct', `${s.keyframes.length > 0 ? (100 * Math.min(i, s.keyframes.length)) / s.keyframes.length : 100}%`);
    commands.showKeyframe(i >= s.keyframes.length ? null : i);
  };
  range.addEventListener('input', onScrub);
  // While the thumb is held, worker echoes of earlier scrub positions must not pull it back.
  let dragging = false;
  range.addEventListener('pointerdown', () => (dragging = true));
  const endDrag = (): void => {
    dragging = false;
  };
  range.addEventListener('pointerup', endDrag);
  range.addEventListener('pointercancel', endDrag);
  range.addEventListener('change', endDrag);
  store.watch((s) => ({
    kfs: s.runtime.keyframes, viewing: s.runtime.viewingKeyframe, interval: s.runtime.keyframeInterval, time: s.runtime.time,
    loaded: s.runtime.worldLoaded, editing: s.runtime.editorActive,
  }), (v) => {
    const n = v.kfs.length;
    range.max = String(n);
    // The plate editor owns the view (as for play/step): no scrubbing or branching meanwhile.
    range.disabled = !v.loaded || n === 0 || v.editing;
    liveBtn.disabled = v.editing;
    branchBtn.disabled = v.editing;
    const pos = v.viewing === null ? n : v.viewing;
    if (!dragging) {
      if (Number(range.value) !== pos) range.value = String(pos);
      range.style.setProperty('--pct', `${n > 0 ? (100 * pos) / n : 100}%`);
    }
    liveBtn.hidden = v.viewing === null;
    branchBtn.hidden = v.viewing === null;
    if (v.viewing !== null && v.kfs[v.viewing]) {
      setText(histLabel, `Viewing ${fmtMyr(v.kfs[v.viewing].time)} · ${v.viewing + 1}/${n}`);
    } else {
      setText(histLabel, n ? `History · ${n} keyframe${n === 1 ? '' : 's'} every ${fmtNum(v.interval, 0)} Myr` : 'History');
    }
    // Tick marks (thinned to ≤ 60).
    const every = Math.max(1, Math.ceil(n / 60));
    const marks: HTMLElement[] = [];
    for (let i = 0; i < n; i += every) marks.push(h('i', { style: { left: `${(100 * i) / Math.max(1, n)}%` } }));
    setChildren(ticks, ...marks);
  }, { immediate: true, equal: shallowEqual });

  /* Month */
  const seasons = button({ icon: 'calendar', variant: 'ghost', title: 'Play seasons (S)', onClick: () => commands.toggleSeasons() });
  const month = h('input', { class: 'wg-range', attrs: { type: 'range', min: -1, max: 11, step: 1, 'aria-label': 'Month' } });
  const monthText = h('span', { class: 'wg-month-label' });
  month.addEventListener('input', () => store.dispatch({ type: 'setMonth', month: Number(month.value) }));
  store.watch((s) => ({ m: s.runtime.month, playing: s.runtime.seasonsPlaying }), (v) => {
    if (Number(month.value) !== v.m) month.value = String(v.m);
    month.style.setProperty('--pct', `${((v.m + 1) / 12) * 100}%`);
    setText(monthText, monthLabel(v.m));
    toggleClass(seasons, 'is-active', v.playing);
  }, { immediate: true, equal: shallowEqual });

  return h('footer', { class: 'wg-timeline' },
    history,
    h('div', { class: 'wg-tl-row' },
      h('div', { class: 'wg-tl-group' }, play, step),
      speed.el,
      time,
      h('div', { class: 'wg-tl-spacer' }),
      h('div', { class: 'wg-month', title: 'Month ([ and ])' }, seasons, month, monthText),
    ),
  );
}
