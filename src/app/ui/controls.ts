/**
 * Form controls with a consistent look: slider rows, switches, selects, segmented controls,
 * buttons, sections. Each returns its element plus a `set` for store-driven updates that never
 * fights an active drag.
 */
import { fmtNum } from '../format';
import { stepDigits, type NumSpec } from '../schema';
import { h, setText, toggleClass, type Child } from './dom';
import { icon, type IconName } from './icons';

export interface Control<T> {
  el: HTMLElement;
  set(value: T): void;
  setDisabled?(disabled: boolean): void;
}

/* ------------------------------------------------------------------ */
/* Slider                                                               */
/* ------------------------------------------------------------------ */

export interface SliderOptions {
  spec: NumSpec;
  value: number;
  /** Multiplier for the readout (e.g. 100 for fractions shown in %). */
  displayScale?: number;
  format?: (v: number) => string;
  /** Called continuously while dragging (cheap updates). */
  onInput?: (v: number) => void;
  /** Called when the user commits (release / keyboard). */
  onChange?: (v: number) => void;
}

export function slider(o: SliderOptions): Control<number> {
  const { spec } = o;
  const scale = o.displayScale ?? 1;
  const digits = Math.max(0, stepDigits(spec) - Math.round(Math.log10(scale)));
  const unit = !spec.unit ? '' : ['×', '%', '°'].includes(spec.unit) ? spec.unit : ` ${spec.unit}`;
  const fmt = o.format ?? ((v: number) => `${fmtNum(v * scale, digits)}${unit}`);
  const input = h('input', {
    class: 'wg-range',
    attrs: { type: 'range', min: spec.min, max: spec.max, step: spec.step, 'aria-label': spec.label },
  });
  input.value = String(o.value);
  const readout = h('span', { class: 'wg-readout' });
  const el = h('label', { class: 'wg-field wg-slider', title: spec.hint ?? '' },
    h('span', { class: 'wg-field-head' }, h('span', { class: 'wg-label', text: spec.label }), readout),
    input,
  );
  let dragging = false;
  const paint = (v: number): void => {
    setText(readout, fmt(v));
    const pct = spec.max > spec.min ? ((v - spec.min) / (spec.max - spec.min)) * 100 : 0;
    input.style.setProperty('--pct', `${Math.max(0, Math.min(100, pct))}%`);
  };
  paint(o.value);
  input.addEventListener('pointerdown', () => (dragging = true));
  input.addEventListener('pointerup', () => (dragging = false));
  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    o.onInput?.(v);
  });
  input.addEventListener('change', () => {
    dragging = false;
    o.onChange?.(Number(input.value));
  });
  return {
    el,
    set(v: number) {
      if (dragging || Number(input.value) === v) return;
      input.value = String(v);
      paint(v);
    },
    setDisabled(d: boolean) {
      input.disabled = d;
      toggleClass(el, 'is-disabled', d);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Switch                                                               */
/* ------------------------------------------------------------------ */

export function switchRow(o: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; icon?: IconName }): Control<boolean> {
  const input = h('input', { class: 'wg-switch-input', attrs: { type: 'checkbox', role: 'switch' } });
  input.checked = o.value;
  input.addEventListener('change', () => o.onChange(input.checked));
  const el = h('label', { class: 'wg-field wg-switch-row', title: o.hint ?? '' },
    o.icon ? icon(o.icon, 15) : null,
    h('span', { class: 'wg-label', text: o.label }),
    h('span', { class: 'wg-switch' }, input, h('span', { class: 'wg-switch-track' }, h('span', { class: 'wg-switch-thumb' }))),
  );
  return {
    el,
    set(v: boolean) {
      if (input.checked !== v) input.checked = v;
    },
    setDisabled(d: boolean) {
      input.disabled = d;
      toggleClass(el, 'is-disabled', d);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Select & segmented                                                   */
/* ------------------------------------------------------------------ */

export interface Option<T extends string | number> {
  value: T;
  label: string;
  title?: string;
  icon?: IconName;
}

export function selectRow<T extends string | number>(o: { label?: string; options: ReadonlyArray<Option<T>>; value: T; onChange: (v: T) => void; hint?: string }): Control<T> {
  const select = h('select', { class: 'wg-select', attrs: { 'aria-label': o.label ?? '' } },
    ...o.options.map((op) => h('option', { attrs: { value: String(op.value) }, text: op.label })),
  );
  select.value = String(o.value);
  select.addEventListener('change', () => {
    const op = o.options.find((x) => String(x.value) === select.value);
    if (op) o.onChange(op.value);
  });
  const el = o.label
    ? h('label', { class: 'wg-field wg-select-row', title: o.hint ?? '' }, h('span', { class: 'wg-label', text: o.label }), select)
    : select;
  return {
    el,
    set(v: T) {
      if (select.value !== String(v)) select.value = String(v);
    },
    setDisabled(d: boolean) {
      select.disabled = d;
    },
  };
}

export function segmented<T extends string | number>(o: { options: ReadonlyArray<Option<T>>; value: T; onChange: (v: T) => void; label?: string; compact?: boolean }): Control<T> {
  const buttons = o.options.map((op) =>
    h('button', {
      class: 'wg-seg-btn',
      title: op.title ?? op.label,
      attrs: { type: 'button', role: 'radio', 'aria-label': op.label },
      onClick: () => o.onChange(op.value),
    }, op.icon ? icon(op.icon, 15) : null, o.compact && op.icon ? null : h('span', { text: op.label })),
  );
  const group = h('div', { class: 'wg-seg', attrs: { role: 'radiogroup', 'aria-label': o.label ?? '' } }, ...buttons);
  const el = o.label ? h('div', { class: 'wg-field' }, h('span', { class: 'wg-label', text: o.label }), group) : group;
  const set = (v: T): void => {
    o.options.forEach((op, i) => {
      const on = op.value === v;
      toggleClass(buttons[i], 'is-active', on);
      buttons[i].setAttribute('aria-checked', String(on));
    });
  };
  set(o.value);
  return {
    el,
    set,
    setDisabled(d: boolean) {
      for (const b of buttons) b.disabled = d;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Buttons, sections, stats                                             */
/* ------------------------------------------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function button(o: { label?: string; icon?: IconName; variant?: ButtonVariant; title?: string; onClick: () => void; kbd?: string; wide?: boolean }): HTMLButtonElement {
  return h('button', {
    class: `wg-btn wg-btn-${o.variant ?? 'secondary'}${o.wide ? ' wg-btn-wide' : ''}${o.label ? '' : ' wg-btn-icon'}`,
    title: o.title ?? o.label ?? '',
    attrs: { type: 'button', 'aria-label': o.title ?? o.label ?? '' },
    onClick: o.onClick,
  },
  o.icon ? icon(o.icon, 16) : null,
  o.label ? h('span', { text: o.label }) : null,
  o.kbd ? h('kbd', { text: o.kbd }) : null);
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'wg-section' }, h('h3', { class: 'wg-section-title', text: title }), ...children);
}

/** Section with a right-aligned action in the title row. */
export function sectionWithAction(title: string, action: HTMLElement, ...children: Child[]): HTMLElement {
  return h('section', { class: 'wg-section' },
    h('div', { class: 'wg-section-head' }, h('h3', { class: 'wg-section-title', text: title }), action),
    ...children);
}

export interface StatGrid {
  el: HTMLElement;
  set(key: string, value: string): void;
}

/** Compact grid of small label-over-value readouts (two per row). */
export function miniStats(items: Array<{ key: string; label: string }>): StatGrid {
  const values = new Map<string, HTMLElement>();
  const el = h('div', { class: 'wg-mini' },
    ...items.map((it) => {
      const v = h('b', { text: '—' });
      values.set(it.key, v);
      return h('div', null, h('span', { text: it.label }), v);
    }),
  );
  return {
    el,
    set(key: string, value: string) {
      const v = values.get(key);
      if (v) setText(v, value);
    },
  };
}

/** Two-column key/value readouts with tabular numbers. */
export function statGrid(items: Array<{ key: string; label: string }>): StatGrid {
  const values = new Map<string, HTMLElement>();
  const el = h('dl', { class: 'wg-stats' },
    ...items.map((it) => {
      const dd = h('dd', { text: '—' });
      values.set(it.key, dd);
      return [h('dt', { text: it.label }), dd];
    }),
  );
  return {
    el,
    set(key: string, value: string) {
      const dd = values.get(key);
      if (dd) setText(dd, value);
    },
  };
}

export function hint(text: string, kind: 'info' | 'warn' = 'info'): HTMLElement {
  return h('p', { class: `wg-hint wg-hint-${kind}` }, icon(kind === 'warn' ? 'alert' : 'info', 14), h('span', { text }));
}

/** Seed field: number input + dice. */
export function seedField(o: { value: number; onChange: (v: number) => void; onRandom: () => void }): Control<number> {
  const input = h('input', { class: 'wg-input wg-mono', attrs: { type: 'number', min: 0, max: 4294967295, step: 1, 'aria-label': 'Seed' } });
  input.value = String(o.value);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) o.onChange(v);
  });
  const dice = button({ icon: 'dice', variant: 'ghost', title: 'Random seed & generate', onClick: o.onRandom });
  const el = h('label', { class: 'wg-field wg-seed' }, h('span', { class: 'wg-label', text: 'Seed' }), h('div', { class: 'wg-input-group' }, input, dice));
  return {
    el,
    set(v: number) {
      if (document.activeElement !== input && input.value !== String(v)) input.value = String(v);
    },
  };
}
